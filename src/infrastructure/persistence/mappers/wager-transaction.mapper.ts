import { FailureCode } from '../../../domain/shared/failure-code';
import { WagerTransaction } from '../../../domain/wagering/wager-transaction';
import { WagerTransactionKind } from '../../../domain/wagering/wager-transaction-kind';
import { WagerTransactionStatus } from '../../../domain/wagering/wager-transaction-status';
import type { WagerTransactionRow } from '../entities/wager-transaction.row';
import { orUndefined, parseColumnEnum } from './column-enum';
import { toAmountColumn, toMoney } from './money.column';

/*
  Colunas que o ciclo de vida da transação altera.

  O resto é imutável desde a criação — identidade, payload, valor e
  referência externa não mudam. É o que mantém o hash de payload capaz de
  distinguir replay de conflito: se o valor pudesse ser atualizado, o hash
  gravado deixaria de descrever a operação armazenada.
*/
export interface WagerTransactionUpdate {
  readonly status: string;
  readonly referenceTransactionId: string | null;
  readonly failureCode: string | null;
  readonly processedAt: Date | null;
  readonly observedBalanceAmount: string | null;
  readonly referenceAttempts: number;
  readonly nextReferenceAttemptAt: Date | null;
}

export function toWagerTransactionDomain(
  row: WagerTransactionRow,
): WagerTransaction {
  const observedBalance = row.observedBalanceAmount;
  const failureCode = row.failureCode;

  return WagerTransaction.rehydrate({
    id: row.id,
    providerId: row.providerId,
    externalTransactionId: row.externalTransactionId,
    idempotencyKey: row.idempotencyKey,
    payloadHash: row.payloadHash,
    walletId: row.walletId,
    playerId: row.playerId,
    roundId: row.roundId,
    gameId: row.gameId,
    kind: parseColumnEnum(
      Object.values(WagerTransactionKind),
      row.kind,
      'wager_transactions.kind',
    ),
    money: toMoney(row.moneyAmount, row.currency),
    referenceExternalTransactionId: orUndefined(
      row.referenceExternalTransactionId,
    ),
    createdAt: row.createdAt,
    status: parseColumnEnum(
      Object.values(WagerTransactionStatus),
      row.status,
      'wager_transactions.status',
    ),
    referenceTransactionId: orUndefined(row.referenceTransactionId),
    /*
      Estrito de propósito: o código de falha é contrato com o provedor, e
      repassar um valor fora da taxonomia documentada seria pior que falhar
      na leitura. O schema não restringe esta coluna — a taxonomia é do
      candidato e cresce —, então é aqui que a divergência aparece.
    */
    failureCode:
      failureCode === null
        ? undefined
        : parseColumnEnum(
            Object.values(FailureCode),
            failureCode,
            'wager_transactions.failure_code',
          ),
    processedAt: orUndefined(row.processedAt),
    observedBalance:
      observedBalance === null
        ? undefined
        : toMoney(observedBalance, row.currency),
    referenceAttempts: row.referenceAttempts,
    nextReferenceAttemptAt: orUndefined(row.nextReferenceAttemptAt),
  });
}

export function toWagerTransactionUpdate(
  transaction: WagerTransaction,
): WagerTransactionUpdate {
  const observedBalance = transaction.observedBalance;

  return {
    status: transaction.status,
    referenceTransactionId: transaction.referenceTransactionId ?? null,
    failureCode: transaction.failureCode ?? null,
    processedAt: transaction.processedAt ?? null,
    observedBalanceAmount:
      observedBalance === undefined ? null : toAmountColumn(observedBalance),
    referenceAttempts: transaction.referenceAttempts,
    nextReferenceAttemptAt: transaction.nextReferenceAttemptAt ?? null,
  };
}

export function toWagerTransactionRow(
  transaction: WagerTransaction,
): WagerTransactionRow {
  return {
    id: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    idempotencyKey: transaction.idempotencyKey,
    payloadHash: transaction.payloadHash,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    currency: transaction.money.currency,
    moneyAmount: toAmountColumn(transaction.money),
    referenceExternalTransactionId:
      transaction.referenceExternalTransactionId ?? null,
    createdAt: transaction.createdAt,
    ...toWagerTransactionUpdate(transaction),
  };
}
