import { LedgerDirection } from '../../../domain/wallet/ledger-direction';
import { WalletLedgerEntry } from '../../../domain/wallet/wallet-ledger-entry';
import { WalletLedgerEntryRow } from '../entities/wallet-ledger-entry.row';
import { parseColumnEnum } from './column-enum';
import { toAmountColumn, toMoney } from './money.column';

/*
  Lançamento: só ida e volta, sem `apply`.

  A ausência de uma função que atualize uma linha do ledger é deliberada — é
  a mesma garantia que o trigger dá no banco e que a imutabilidade estrutural
  dá no domínio, aqui na forma mais simples: não existe o código que faria
  isso.
*/
export function toLedgerEntryDomain(
  row: WalletLedgerEntryRow,
): WalletLedgerEntry {
  return WalletLedgerEntry.rehydrate({
    id: row.id,
    walletId: row.walletId,
    transactionId: row.transactionId,
    direction: parseColumnEnum(
      Object.values(LedgerDirection),
      row.direction,
      'wallet_ledger_entries.direction',
    ),
    money: toMoney(row.moneyAmount, row.currency),
    balanceBefore: toMoney(row.balanceBeforeAmount, row.currency),
    balanceAfter: toMoney(row.balanceAfterAmount, row.currency),
    createdAt: row.createdAt,
  });
}

export function toLedgerEntryRow(
  entry: WalletLedgerEntry,
): WalletLedgerEntryRow {
  const row = new WalletLedgerEntryRow();
  row.id = entry.id;
  row.walletId = entry.walletId;
  row.transactionId = entry.transactionId;
  row.direction = entry.direction;
  /*
    Uma moeda para os três valores. O domínio já recusou lançamento com
    moedas divergentes em `create`, e o schema não tem onde representar um.
  */
  row.currency = entry.money.currency;
  row.moneyAmount = toAmountColumn(entry.money);
  row.balanceBeforeAmount = toAmountColumn(entry.balanceBefore);
  row.balanceAfterAmount = toAmountColumn(entry.balanceAfter);
  row.createdAt = entry.createdAt;
  return row;
}
