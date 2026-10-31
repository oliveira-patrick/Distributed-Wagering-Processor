import type { MoneyProps } from '../../money/money';
import type { FailureCode } from '../../shared/failure-code';
import { InvariantViolationError } from '../../shared/invariant-violation-error';
import type { WagerTransaction } from '../../wagering/wager-transaction';
import { WagerTransactionStatus } from '../../wagering/wager-transaction-status';
import { IntegrationEvent } from '../integration-event';
import type { EventContext } from '../integration-event';
import { describeTransaction } from './wager-transaction.descriptor';
import type { WagerTransactionDescriptor } from './wager-transaction.descriptor';

export interface WagerTransactionRejectedData extends WagerTransactionDescriptor {
  readonly failureCode: FailureCode;
  /*
    Saldo observado, quando houve um para observar.

    Ausente nas recusas decididas antes de a wallet ser consultada. Havendo
    ou não saldo observado, a recusa não alterou nada: ela não move saldo nem
    gera lançamento.
  */
  readonly balance: MoneyProps | undefined;
  readonly rejectedAt: string;
}

/*
  Transação recusada por regra de negócio.

  Recusa é **resultado**, não falha: a operação foi avaliada e negada, o que é
  informação que o provedor precisa receber. Por isso ela é persistida, fica
  auditável e gera evento, em vez de virar só um código de erro HTTP que o
  provedor pode nunca ter lido.
*/
export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(
    transaction: WagerTransaction,
    ctx: EventContext,
  ): WagerTransactionRejected {
    const failureCode = transaction.failureCode;
    const rejectedAt = transaction.processedAt;

    if (
      transaction.status !== WagerTransactionStatus.Rejected ||
      failureCode === undefined ||
      rejectedAt === undefined
    ) {
      throw new InvariantViolationError(
        `WagerTransactionRejected exige transação REJECTED com código e ` +
          `instante; recebido ${transaction.status}`,
      );
    }

    return new WagerTransactionRejected({
      eventId: ctx.eventId,
      aggregateId: transaction.walletId,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: ctx.occurredAt,
      data: {
        ...describeTransaction(transaction),
        failureCode,
        balance: transaction.observedBalance?.toJSON(),
        rejectedAt: rejectedAt.toISOString(),
      },
    });
  }
}
