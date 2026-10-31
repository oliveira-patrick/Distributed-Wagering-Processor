import { GetQueueUrlCommand, SendMessageCommand } from '@aws-sdk/client-sqs';
import type { SQSClient } from '@aws-sdk/client-sqs';

import type { IntegrationEventPublisher } from '../../application/ports/event-publisher.port';
import type { OutboxMessage } from '../../domain/messaging/outbox-message';

/*
  Publica os eventos de integração na fila de saída.

  Duas escolhas, e as duas são a corretude do desenho:

  **`MessageGroupId` = `aggregateId`, que é a `walletId`.** O grupo é a
  unidade de ordenação do SQS FIFO, e a wallet é a unidade de concorrência e
  a fronteira de consistência do domínio. Com o `eventId` no lugar, cada
  evento viraria o próprio grupo e a ordem relativa entre eventos da mesma
  wallet se perderia — um consumidor que reconstrói saldo veria o crédito
  antes do débito.

  **`MessageDeduplicationId` = `id`, que é o `eventId`.** É o que torna
  inofensiva a republicação de um evento cujo `markPublished` não chegou a
  comitar. Dentro da janela de cinco minutos do broker, a duplicata nem
  chega ao consumidor; fora dela, quem recusa é o inbox persistente. A
  deduplicação por conteúdo fica desligada na topologia justamente para que
  este id explícito seja o critério.
*/
export class SqsEventPublisher implements IntegrationEventPublisher {
  private queueUrl: string | undefined;

  constructor(
    private readonly client: SQSClient,
    private readonly queueName: string,
  ) {}

  async publish(message: OutboxMessage): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: await this.resolveQueueUrl(),
        MessageBody: JSON.stringify(message.payload),
        MessageGroupId: message.aggregateId,
        MessageDeduplicationId: message.id,
      }),
    );
  }

  /*
    Resolvida na primeira publicação, não na construção.

    O worker precisa subir mesmo com o SQS fora do ar — a mesma razão do
    `connect: false` do MikroORM — para que o readiness reporte
    indisponibilidade em vez de o processo morrer na inicialização.
  */
  private async resolveQueueUrl(): Promise<string> {
    if (this.queueUrl !== undefined) {
      return this.queueUrl;
    }

    const { QueueUrl } = await this.client.send(
      new GetQueueUrlCommand({ QueueName: this.queueName }),
    );

    if (QueueUrl === undefined) {
      throw new Error(`GetQueueUrl não devolveu URL para ${this.queueName}`);
    }

    this.queueUrl = QueueUrl;
    return QueueUrl;
  }
}
