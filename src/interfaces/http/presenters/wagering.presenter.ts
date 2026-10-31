import type { Money } from '../../../domain/money/money';
import type { FailureCode } from '../../../domain/shared/failure-code';
import type { WagerTransaction } from '../../../domain/wagering/wager-transaction';
import type { WagerTransactionKind } from '../../../domain/wagering/wager-transaction-kind';
import type { WagerTransactionStatus } from '../../../domain/wagering/wager-transaction-status';
import { presentMoney } from './money.presenter';
import type { MoneyResponse } from './money.presenter';

/*
  Resposta de `POST /wagering/transactions`.

  Os quatro primeiros campos são exatamente os do contrato público. O
  `failureCode` aparece só na recusa, e é a razão de a recusa usar **este**
  corpo em vez de um corpo de erro genérico: a transação recusada existe, tem
  id e é auditável, e o provedor precisa dos dois — o código, para decidir o
  que fazer, e o id, para consultar depois. Um corpo diferente obrigaria a
  fazer parsing condicional da resposta.
*/
export interface SubmitTransactionResponse {
  readonly transactionId: string;
  readonly status: WagerTransactionStatus;
  readonly balance: MoneyResponse;
  readonly idempotentReplay: boolean;
  readonly failureCode?: FailureCode;
}

export function presentSubmitResult(
  transaction: WagerTransaction,
  balance: Money,
  idempotentReplay: boolean,
): SubmitTransactionResponse {
  const failureCode = transaction.failureCode;

  return {
    transactionId: transaction.id,
    status: transaction.status,
    balance: presentMoney(balance),
    idempotentReplay,
    ...(failureCode === undefined ? {} : { failureCode }),
  };
}

// Resposta das duas consultas de transação.
export interface WagerTransactionResponse {
  readonly transactionId: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly money: MoneyResponse;
  readonly status: WagerTransactionStatus;
  readonly createdAt: string;
  readonly referenceAttempts: number;
  // Saldo observado no instante em que a transação terminou.
  readonly observedBalance?: MoneyResponse;
  readonly failureCode?: FailureCode;
  readonly processedAt?: string;
  readonly referenceExternalTransactionId?: string;
  readonly referenceTransactionId?: string;
  readonly nextReferenceAttemptAt?: string;
}

export function presentTransaction(
  transaction: WagerTransaction,
): WagerTransactionResponse {
  const observedBalance = transaction.observedBalance;
  const failureCode = transaction.failureCode;
  const processedAt = transaction.processedAt;
  const referenceExternalTransactionId =
    transaction.referenceExternalTransactionId;
  const referenceTransactionId = transaction.referenceTransactionId;
  const nextReferenceAttemptAt = transaction.nextReferenceAttemptAt;

  return {
    transactionId: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    playerId: transaction.playerId,
    walletId: transaction.walletId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    money: presentMoney(transaction.money),
    status: transaction.status,
    createdAt: transaction.createdAt.toISOString(),
    referenceAttempts: transaction.referenceAttempts,
    /*
      Campo ausente é campo **omitido**, não `null`. Com
      `exactOptionalPropertyTypes` o tipo já proíbe `undefined` explícito, e o
      corpo fica sem chave vazia — a mesma regra do envelope da outbox.
    */
    ...(observedBalance === undefined
      ? {}
      : { observedBalance: presentMoney(observedBalance) }),
    ...(failureCode === undefined ? {} : { failureCode }),
    ...(processedAt === undefined
      ? {}
      : { processedAt: processedAt.toISOString() }),
    ...(referenceExternalTransactionId === undefined
      ? {}
      : { referenceExternalTransactionId }),
    ...(referenceTransactionId === undefined ? {} : { referenceTransactionId }),
    ...(nextReferenceAttemptAt === undefined
      ? {}
      : { nextReferenceAttemptAt: nextReferenceAttemptAt.toISOString() }),
  };
}
