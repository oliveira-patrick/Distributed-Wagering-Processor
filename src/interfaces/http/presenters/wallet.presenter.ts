import type { LedgerDirection } from '../../../domain/wallet/ledger-direction';
import type { Wallet } from '../../../domain/wallet/wallet';
import type { WalletLedgerEntry } from '../../../domain/wallet/wallet-ledger-entry';
import type { ReconciliationReport } from '../../../application/use-cases/reconcile-wallet.use-case';
import { presentMoney } from './money.presenter';
import type { MoneyResponse } from './money.presenter';

// Exatamente os campos do contrato de wallet.
export interface WalletResponse {
  readonly id: string;
  readonly playerId: string;
  readonly balance: MoneyResponse;
  readonly version: number;
}

export function presentWallet(wallet: Wallet): WalletResponse {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    balance: presentMoney(wallet.balance),
    version: wallet.version,
  };
}

export interface LedgerEntryResponse {
  readonly id: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly money: MoneyResponse;
  readonly balanceBefore: MoneyResponse;
  readonly balanceAfter: MoneyResponse;
  readonly createdAt: string;
}

export interface LedgerPageResponse {
  readonly entries: readonly LedgerEntryResponse[];
  /*
    Ausente na última página.

    Opaco de propósito: quem integra deve devolvê-lo intacto, não construí-lo.
    Ver `application/contracts/ledger-cursor.ts`.
  */
  readonly nextCursor?: string;
}

export function presentLedgerEntry(
  entry: WalletLedgerEntry,
): LedgerEntryResponse {
  return {
    id: entry.id,
    transactionId: entry.transactionId,
    direction: entry.direction,
    money: presentMoney(entry.money),
    balanceBefore: presentMoney(entry.balanceBefore),
    balanceAfter: presentMoney(entry.balanceAfter),
    createdAt: entry.createdAt.toISOString(),
  };
}

export function presentLedgerPage(
  entries: readonly WalletLedgerEntry[],
  nextCursor: string | undefined,
): LedgerPageResponse {
  return {
    entries: entries.map(presentLedgerEntry),
    ...(nextCursor === undefined ? {} : { nextCursor }),
  };
}

// Exatamente os campos do contrato de reconciliação.
export interface ReconciliationResponse {
  readonly walletId: string;
  readonly storedBalance: MoneyResponse;
  readonly calculatedBalance: MoneyResponse;
  readonly difference: MoneyResponse;
  readonly consistent: boolean;
  readonly checkedEntries: number;
}

export function presentReconciliation(
  report: ReconciliationReport,
): ReconciliationResponse {
  return {
    walletId: report.walletId,
    storedBalance: presentMoney(report.storedBalance),
    calculatedBalance: presentMoney(report.calculatedBalance),
    difference: presentMoney(report.difference),
    consistent: report.consistent,
    checkedEntries: report.checkedEntries,
  };
}
