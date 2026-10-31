import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueUrlCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';
import type { Message, SQSClient } from '@aws-sdk/client-sqs';

import { wagerMessageSchema } from '../../application/contracts/wager-message.schema';
import type { WagerMessage } from '../../application/contracts/wager-message.schema';
import type { ConsumeWagerMessageUseCase } from '../../application/use-cases/consume-wager-message.use-case';
import { Metric } from '../../application/ports/metrics.port';
import type { MetricsPort } from '../../application/ports/metrics.port';
import type { LoggerPort } from '../../application/ports/logger.port';
import { describeError } from '../../shared/describe-error';
import { isTransportFailure } from '../../shared/transport-failure';
import { RECEIVE_WAIT_TIME_SECONDS } from './queue-topology';

export interface SqsConsumerOptions {
  readonly queueName: string;
  readonly deadLetterQueueName: string;
  readonly maxMessages: number;
  readonly shutdownTimeoutMs: number;
}

/*
  Mensagem que o payload não permite processar.

  Erro **permanente**, e a distinção tem consequência: um payload fora do
  contrato não melhora na segunda entrega. Deixá-lo voltar pela fila gastaria
  as cinco entregas do `maxReceiveCount` para chegar ao mesmo lugar, mantendo
  capacidade do consumidor ocupada com algo que nunca vai passar.
*/
class PermanentMessageError extends Error {
  constructor(reason: string, detail: string) {
    super(`${reason}: ${detail}`);
    this.name = 'PermanentMessageError';
    this.reason = reason;
  }

  readonly reason: string;
}

/*
  Consumidor da fila de entrada.

  As três decisões que sustentam a corretude:

  **`ack` só depois do commit.** O `DeleteMessage` acontece depois de o caso
  de uso retornar, nunca antes. Morrendo no meio, a mensagem reaparece e o
  inbox a reconhece como já processada — é a combinação das duas coisas que
  torna o redelivery inofensivo, não cada uma isolada.

  **Grupos em paralelo, mensagens do grupo em sequência.** Uma chamada de
  `ReceiveMessage` numa fila FIFO pode trazer várias mensagens do mesmo
  `MessageGroupId`, em ordem. Processá-las em paralelo jogaria fora a
  ordenação que a fila acabou de garantir e poria duas operações da mesma
  wallet disputando o mesmo lock. Grupos diferentes são wallets diferentes e
  não se bloqueiam, então esses sim vão juntos.

  **Erro classificado em três, não em dois.** Negócio é terminal e recebe
  `ack`; transitório não recebe `ack` e volta pela fila, onde o
  `maxReceiveCount` acaba levando à DLQ se insistir; permanente vai para a
  DLQ na hora. Ver ADR-011.
*/
export class SqsWagerConsumer {
  private running = false;
  private loop: Promise<void> | undefined;
  private queueUrl: string | undefined;
  private deadLetterUrl: string | undefined;

  /*
    Cancela o `ReceiveMessage` em curso no shutdown.

    Sem ele, parar o consumidor esperaria o long poll inteiro — vinte
    segundos —, muito além do prazo de encerramento e do intervalo que o
    Compose dá entre `SIGTERM` e `SIGKILL`. O resultado prático seria um
    shutdown "gracioso" que nunca termina a tempo.
  */
  private receiveAbort: AbortController | undefined;

  // Em processamento agora, por `receiptHandle`.
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(
    private readonly client: SQSClient,
    private readonly consume: ConsumeWagerMessageUseCase,
    private readonly options: SqsConsumerOptions,
    private readonly logger: LoggerPort,
    private readonly metrics: MetricsPort,
  ) {}

  /*
    Começa a consumir. Não espera pela primeira entrega.

    Não resolve a URL da fila aqui: a aplicação precisa subir mesmo com o SQS
    fora do ar — a mesma razão do `connect: false` do MikroORM —, para que o
    readiness possa reportar indisponibilidade em vez de o processo morrer na
    inicialização.
  */
  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.loop = this.runLoop();
  }

  /*
    Encerramento gracioso, no `SIGTERM`.

    Para de receber, espera o que está em andamento e, se o prazo estourar,
    **devolve a visibilidade** das mensagens que sobraram em vez de
    abandoná-las. Sem isso, uma mensagem presa num processo que morreu só
    voltaria a ser entregue ao fim do `VisibilityTimeout` — trinta segundos
    de latência que não há razão para pagar.
  */
  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }
    this.running = false;
    this.receiveAbort?.abort();

    /*
      O prazo cobre a volta inteira do laço, não só o conjunto em andamento:
      quando `stop` é chamado, o mais provável é que o laço esteja no meio de
      um lote, e é esse lote que precisa terminar.
    */
    const finished = await Promise.race([
      (this.loop ?? Promise.resolve()).then(() => true),
      delay(this.options.shutdownTimeoutMs).then(() => false),
    ]);

    this.loop = undefined;

    if (!finished) {
      this.logger.warn('shutdown excedeu o prazo; devolvendo visibilidade', {
        inFlight: this.inFlight.size,
      });
      await this.releaseInFlight();
    }
  }

  private async runLoop(): Promise<void> {
    while (this.running) {
      try {
        const messages = await this.receive();
        if (messages.length > 0) {
          await this.handleBatch(messages);
        }
      } catch (error) {
        /*
          Cancelamento pedido pelo `stop` não é falha: é o shutdown
          funcionando. Logá-lo como erro treinaria quem opera a ignorar o
          log de erro deste worker.

          A pergunta passa por método porque `this.running` é alterado de
          fora, entre dois `await`: lido direto, o compilador o estreita a
          partir da condição do laço e conclui que o teste nunca é
          verdadeiro, o que é exatamente a situação que este `if` trata.
        */
        if (this.isStopping()) {
          break;
        }

        /*
          Indisponibilidade do SQS não derruba o worker: ele volta a tentar,
          e o SDK já aplicou o próprio backoff entre as tentativas internas.
        */
        this.logger.error('falha ao receber da fila', {
          detail: describeError(error),
          transient: isTransportFailure(error),
        });
        await delay(RECEIVE_RETRY_DELAY_MS);
      }
    }
  }

  private async receive(): Promise<readonly Message[]> {
    const queueUrl = await this.resolveQueueUrl();
    const abort = new AbortController();
    this.receiveAbort = abort;

    try {
      const result = await this.client.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: this.options.maxMessages,
          WaitTimeSeconds: RECEIVE_WAIT_TIME_SECONDS,
          /*
            `ApproximateReceiveCount` diz quantas vezes esta mensagem já foi
            entregue. É o que permite ver no log que algo está a caminho da
            DLQ antes de chegar lá.
          */
          MessageSystemAttributeNames: [
            'ApproximateReceiveCount',
            'MessageGroupId',
          ],
        }),
        { abortSignal: abort.signal },
      );

      return result.Messages ?? [];
    } finally {
      this.receiveAbort = undefined;
    }
  }

  /*
    Grupos em paralelo; dentro do grupo, um por vez.

    Mensagem sem `MessageGroupId` não deveria existir numa fila FIFO, mas se
    existir ela ganha um grupo próprio — tratá-la como parte de um grupo
    alheio serializaria wallets que nada têm a ver uma com a outra.
  */
  private async handleBatch(messages: readonly Message[]): Promise<void> {
    const groups = new Map<string, Message[]>();

    for (const message of messages) {
      const group =
        message.Attributes?.MessageGroupId ?? `solo:${message.MessageId ?? ''}`;
      const existing = groups.get(group);
      if (existing === undefined) {
        groups.set(group, [message]);
      } else {
        existing.push(message);
      }
    }

    await Promise.all(
      [...groups.values()].map(async (group) => {
        for (const message of group) {
          await this.track(message);
        }
      }),
    );
  }

  // Registra a mensagem como em andamento, para o shutdown saber dela.
  private async track(message: Message): Promise<void> {
    const handle = message.ReceiptHandle;
    if (handle === undefined) {
      this.logger.error('mensagem sem ReceiptHandle, impossível confirmar', {
        messageId: message.MessageId,
      });
      return;
    }

    const work = this.handle(message, handle);
    this.inFlight.set(handle, work);

    try {
      await work;
    } finally {
      this.inFlight.delete(handle);
    }
  }

  private async handle(message: Message, handle: string): Promise<void> {
    const receiveCount = Number(
      message.Attributes?.ApproximateReceiveCount ?? '1',
    );

    try {
      const parsed = this.parse(message);
      const result = await this.consume.execute(parsed);

      // Aqui, e só aqui: o commit já aconteceu.
      await this.acknowledge(handle);

      this.metrics.increment(Metric.MessagesReceivedTotal, {
        outcome: result.outcome,
      });
    } catch (error) {
      if (error instanceof PermanentMessageError) {
        await this.deadLetter(message, handle, error);
        return;
      }

      /*
        Transitório, ou erro inesperado tratado como tal. Sem `ack`: a
        mensagem volta pela fila, e se insistir o `maxReceiveCount` a manda
        para a DLQ. Tratar bug como permanente descartaria na primeira
        tentativa uma operação financeira que talvez passasse na segunda.
      */
      this.metrics.increment(Metric.MessagesReceivedTotal, {
        outcome: 'retry',
      });
      this.metrics.increment(Metric.RetriesTotal, { subject: 'message' });

      this.logger.error('mensagem devolvida à fila', {
        messageId: message.MessageId,
        receiveCount,
        transient: isTransportFailure(error),
        detail: describeError(error),
      });
    }
  }

  /*
    Valida o envelope da mensagem.

    Corpo ausente, JSON inválido, tipo inesperado e payload fora do contrato
    são todos permanentes — nenhum deles muda na reentrega.
  */
  private parse(message: Message): WagerMessage {
    if (message.Body === undefined || message.Body === '') {
      throw new PermanentMessageError('EMPTY_BODY', 'mensagem sem corpo');
    }

    let raw: unknown;
    try {
      raw = JSON.parse(message.Body);
    } catch (error) {
      throw new PermanentMessageError('INVALID_JSON', describeError(error));
    }

    const parsed = wagerMessageSchema.safeParse(raw);
    if (!parsed.success) {
      throw new PermanentMessageError(
        'SCHEMA_VIOLATION',
        parsed.error.issues
          .map(
            (issue) => `${issue.path.join('.') || '(raiz)'}: ${issue.message}`,
          )
          .join('; '),
      );
    }

    return parsed.data;
  }

  private async acknowledge(handle: string): Promise<void> {
    await this.client.send(
      new DeleteMessageCommand({
        QueueUrl: await this.resolveQueueUrl(),
        ReceiptHandle: handle,
      }),
    );
  }

  /*
    Envia à DLQ e confirma a original.

    A ordem importa: enviar primeiro e confirmar depois pode duplicar na DLQ
    se o processo morrer entre as duas, e duplicata na DLQ é inspeção
    repetida. Confirmar primeiro perderia a mensagem — e perder evidência de
    um payload defeituoso é bem pior que inspecioná-lo duas vezes.
  */
  private async deadLetter(
    message: Message,
    handle: string,
    error: PermanentMessageError,
  ): Promise<void> {
    const group = message.Attributes?.MessageGroupId ?? 'permanent-failure';

    await this.client.send(
      new SendMessageCommand({
        QueueUrl: await this.resolveDeadLetterUrl(),
        MessageBody: message.Body ?? '',
        MessageGroupId: group,
        /*
          A fila não tem deduplicação por conteúdo; o id da mensagem original
          é o que impede a mesma falha de entrar duas vezes na janela.
        */
        MessageDeduplicationId: message.MessageId ?? group,
      }),
    );

    await this.acknowledge(handle);

    this.metrics.increment(Metric.DlqMessagesTotal, { reason: error.reason });
    this.metrics.increment(Metric.MessagesReceivedTotal, {
      outcome: 'dead-lettered',
    });

    this.logger.error('mensagem enviada à DLQ por erro permanente', {
      messageId: message.MessageId,
      reason: error.reason,
      detail: error.message,
    });
  }

  // Devolve a visibilidade para a mensagem reaparecer já, não em 30 s.
  private async releaseInFlight(): Promise<void> {
    const handles = [...this.inFlight.keys()];

    await Promise.allSettled(
      handles.map(async (handle) =>
        this.client.send(
          new ChangeMessageVisibilityCommand({
            QueueUrl: await this.resolveQueueUrl(),
            ReceiptHandle: handle,
            VisibilityTimeout: 0,
          }),
        ),
      ),
    );
  }

  private isStopping(): boolean {
    return !this.running;
  }

  private async resolveQueueUrl(): Promise<string> {
    this.queueUrl ??= await this.lookup(this.options.queueName);
    return this.queueUrl;
  }

  private async resolveDeadLetterUrl(): Promise<string> {
    this.deadLetterUrl ??= await this.lookup(this.options.deadLetterQueueName);
    return this.deadLetterUrl;
  }

  private async lookup(queueName: string): Promise<string> {
    const { QueueUrl } = await this.client.send(
      new GetQueueUrlCommand({ QueueName: queueName }),
    );

    if (QueueUrl === undefined) {
      throw new Error(`GetQueueUrl não devolveu URL para ${queueName}`);
    }

    return QueueUrl;
  }
}

// Espera curta depois de falha de recebimento, para não girar em vazio.
const RECEIVE_RETRY_DELAY_MS = 1_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
