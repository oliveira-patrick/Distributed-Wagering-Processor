import { InboxMessage } from '../../domain/messaging/inbox-message';
import type { WagerMessage } from '../contracts/wager-message.schema';
import type { SubmitWagerTransactionInput } from '../contracts/submit-wager-transaction.command';
import { Metric, MetricSource } from '../ports/metrics.port';
import type { MetricsPort } from '../ports/metrics.port';
import type { LoggerPort } from '../ports/logger.port';
import type { Clock, IdGenerator } from '../ports/system.port';
import type { UnitOfWork } from '../ports/unit-of-work';
import { SubmissionOperation, recordSubmission } from './submission-telemetry';
import type { SubmitWagerTransactionUseCase } from './submit-wager-transaction.use-case';
import type { SubmitWagerTransactionResult } from './submit-wager-transaction.use-case';

/*
  Desfecho do consumo, do ponto de vista de quem decide o `ack`.

  Os dois são terminais e recebem `ack`. O que **não** aparece aqui é falha
  de transporte: ela sai como exceção, porque não é desfecho do negócio e
  quem a trata é o consumidor, deixando a mensagem voltar pela fila. Separar
  as duas coisas por tipo em vez de por campo é o que impede o consumidor de
  confirmar uma mensagem cujo commit não aconteceu.
*/
export type ConsumeWagerMessageResult =
  | {
      readonly outcome: 'processed';
      readonly submission: SubmitWagerTransactionResult;
    }
  | { readonly outcome: 'duplicate' };

/*
  Consumo de `WagerTransactionRequested`.

  Reusa **o mesmo caso de uso** da entrada HTTP, e é por isso que
  `SubmitWagerTransactionUseCase` está dividido em `prepare` e
  `executeWithin`: a transação é aberta **aqui**, o registro de inbox entra
  nela, e o efeito financeiro vem depois no mesmo commit. Inbox, transação,
  saldo, ledger e outbox num commit só.

  A ordem dentro da transação não é arbitrária:

  1. o inbox é inserido **primeiro**, e a colisão da chave primária composta
     `(consumer_name, message_id)` é a resposta da deduplicação — mesmo
     padrão da idempotência por constraint do ADR-010, pela mesma razão:
     consultar antes de inserir devolveria "não existe" para duas entregas
     concorrentes da mesma mensagem;
  2. só então o efeito financeiro, que pode falhar e levar o inbox embora no
     rollback — o que é o comportamento correto, porque a mensagem precisa
     voltar pela fila.
*/
export class ConsumeWagerMessageUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly submit: SubmitWagerTransactionUseCase,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly logger: LoggerPort,
    private readonly metrics: MetricsPort,
    private readonly consumerName: string,
  ) {}

  async execute(message: WagerMessage): Promise<ConsumeWagerMessageResult> {
    const startedAt = this.clock.now().getTime();
    const { idempotencyKey, ...payload } = message.data;

    const input: SubmitWagerTransactionInput = {
      idempotencyKey,
      correlationId: message.correlationId ?? this.ids.next(),
      payload,
      /* 
        Sem credencial: a fila é canal interno confiável quanto ao
        transporte. O `providerId` da mensagem continua sujeito à validação
        de domínio: confiável quanto ao canal não é confiável quanto ao conteúdo.
      */
    };

    const prepared = await this.submit.prepare(input);

    if (prepared.outcome === 'refused') {
      /*
        Recusa anterior a qualquer escrita: não há inbox a gravar porque não
        houve efeito, e reentregar produziria a mesma recusa.
      */
      this.logRefusal(message, input.correlationId, prepared.detail);
      this.record(input, prepared, startedAt);
      return { outcome: 'processed', submission: prepared };
    }

    const result = await this.unitOfWork.run(async (repositories) => {
      const now = this.clock.now();

      const received = InboxMessage.receive({
        messageId: message.messageId,
        consumerName: this.consumerName,
        payloadHash: prepared.payloadHash,
        receivedAt: now,
      });

      if (!(await repositories.inbox.tryInsert(received))) {
        return { outcome: 'duplicate' } as const;
      }

      const submission = await this.submit.executeWithin(
        repositories,
        input,
        prepared.payloadHash,
      );

      received.markProcessed(now);
      await repositories.inbox.save(received);

      return { outcome: 'processed', submission } as const;
    });

    if (result.outcome === 'duplicate') {
      /*
        Redelivery. Efeito duplicado é o pior desfecho possível aqui, e é
        esta linha que prova que ele não acontece.
      */
      this.metrics.increment(Metric.DuplicatesTotal, { guard: 'inbox' });
      this.logger.info('mensagem já processada, descartada pelo inbox', {
        correlationId: input.correlationId,
        messageId: message.messageId,
        providerId: payload.providerId,
        walletId: payload.walletId,
      });
      return result;
    }

    this.logSubmission(message, input.correlationId, result.submission);
    this.record(input, result.submission, startedAt);

    return result;
  }

  // Métricas depois do commit — antes, um rollback já teria sido contado.
  private record(
    input: SubmitWagerTransactionInput,
    submission: SubmitWagerTransactionResult,
    startedAt: number,
  ): void {
    recordSubmission(
      this.metrics,
      MetricSource.Sqs,
      SubmissionOperation.Consume,
      submission,
      (this.clock.now().getTime() - startedAt) / 1_000,
    );
  }

  private logRefusal(
    message: WagerMessage,
    correlationId: string,
    detail: string,
  ): void {
    this.logger.warn('mensagem recusada antes de persistir', {
      correlationId,
      messageId: message.messageId,
      providerId: message.data.providerId,
      walletId: message.data.walletId,
      detail,
    });
  }

  private logSubmission(
    message: WagerMessage,
    correlationId: string,
    submission: SubmitWagerTransactionResult,
  ): void {
    if (submission.outcome === 'refused') {
      this.logRefusal(message, correlationId, submission.detail);
      return;
    }

    this.logger.info('mensagem processada', {
      correlationId,
      messageId: message.messageId,
      transactionId: submission.transaction.id,
      walletId: submission.transaction.walletId,
      providerId: submission.transaction.providerId,
      status: submission.transaction.status,
      idempotentReplay: submission.idempotentReplay,
    });
  }
}
