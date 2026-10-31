import type { MoneyProps } from '../../money/money';
import { InvariantViolationError } from '../../shared/invariant-violation-error';
import type { WagerTransaction } from '../../wagering/wager-transaction';
import { WagerTransactionStatus } from '../../wagering/wager-transaction-status';
import { IntegrationEvent } from '../integration-event';
import type { EventContext } from '../integration-event';
import { describeTransaction } from './wager-transaction.descriptor';
import type { WagerTransactionDescriptor } from './wager-transaction.descriptor';

export interface WagerTransactionProcessedData extends WagerTransactionDescriptor {
  // Saldo observado no instante da aplicação, devolvido no replay.
  readonly balance: MoneyProps;
  readonly referenceTransactionId: string | undefined;
  readonly processedAt: string;
}

/*
  Transação aplicada — **inclusive `LOSS`**, que não move saldo.

  `LOSS` não move saldo e não gera lançamento, mas é um resultado registrado, e
  um consumidor que acompanha o histórico de uma rodada precisa dele. É por
  isso que este evento existe separado de `WalletBalanceChanged`.
*/
export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(
    transaction: WagerTransaction,
    ctx: EventContext,
  ): WagerTransactionProcessed {
    const balance = transaction.observedBalance;
    const processedAt = transaction.processedAt;

    /*
      Guarda, não validação de entrada: chegar aqui com transação não aplicada
      é erro de programação no caso de uso, não payload ruim de provedor.
    */
    if (
      transaction.status !== WagerTransactionStatus.Processed ||
      balance === undefined ||
      processedAt === undefined
    ) {
      throw new InvariantViolationError(
        `WagerTransactionProcessed exige transação PROCESSED com saldo e ` +
          `instante observados; recebido ${transaction.status}`,
      );
    }

    return new WagerTransactionProcessed({
      eventId: ctx.eventId,
      aggregateId: transaction.walletId,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: ctx.occurredAt,
      data: {
        ...describeTransaction(transaction),
        balance: balance.toJSON(),
        referenceTransactionId: transaction.referenceTransactionId,
        processedAt: processedAt.toISOString(),
      },
    });
  }
}
