import { InvariantViolationError } from '../../shared/invariant-violation-error';
import type { WagerTransaction } from '../../wagering/wager-transaction';
import { WagerTransactionStatus } from '../../wagering/wager-transaction-status';
import { IntegrationEvent } from '../integration-event';
import type { EventContext } from '../integration-event';
import { describeTransaction } from './wager-transaction.descriptor';
import type { WagerTransactionDescriptor } from './wager-transaction.descriptor';

export interface WagerTransactionPendingReferenceData extends WagerTransactionDescriptor {
  readonly referenceExternalTransactionId: string;
  readonly attempts: number;
  readonly nextAttemptAt: string;
}

/*
  Referência ausente: a transação foi aceita e aguarda reavaliação.

  A transação foi **aceita** e não aplicada: a operação que ela reverte ainda
  não chegou. Com entrega at-least-once e sem ordem garantida, isso é situação
  esperada, não exceção — e é por isso que o evento existe em vez de a
  operação ser recusada na hora.

  O payload leva `attempts` e `nextAttemptAt` para que quem acompanha saiba que
  o reprocessamento está agendado, e quando. Sem isso, "pendente" é
  indistinguível de "esquecida".
*/
export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(
    transaction: WagerTransaction,
    ctx: EventContext,
  ): WagerTransactionPendingReference {
    const reference = transaction.referenceExternalTransactionId;
    const nextAttemptAt = transaction.nextReferenceAttemptAt;

    if (
      transaction.status !== WagerTransactionStatus.PendingReference ||
      reference === undefined ||
      nextAttemptAt === undefined
    ) {
      throw new InvariantViolationError(
        `WagerTransactionPendingReference exige transação PENDING_REFERENCE ` +
          `com referência e agendamento; recebido ${transaction.status}`,
      );
    }

    return new WagerTransactionPendingReference({
      eventId: ctx.eventId,
      aggregateId: transaction.walletId,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: ctx.occurredAt,
      data: {
        ...describeTransaction(transaction),
        referenceExternalTransactionId: reference,
        attempts: transaction.referenceAttempts,
        nextAttemptAt: nextAttemptAt.toISOString(),
      },
    });
  }
}
