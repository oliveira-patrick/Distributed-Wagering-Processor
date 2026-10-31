import { Wallet } from '../../../domain/wallet/wallet';
import type { WalletRow } from '../entities/wallet.row';
import { toAmountColumn, toMoney } from './money.column';

/*
  Colunas que a wallet pode ter mudado depois de aberta.

  Separado da linha inteira porque o `update` precisa dizer exatamente o que
  muda: identidade, `playerId` e `createdAt` ficam de fora porque não mudam, e
  um `update` que os mencionasse seria uma oportunidade de sobrescrevê-los
  com valor errado.
*/
export interface WalletUpdate {
  readonly currency: string;
  readonly balanceAmount: string;
  readonly version: number;
  readonly updatedAt: Date;
}

export function toWalletDomain(row: WalletRow): Wallet {
  return Wallet.rehydrate({
    id: row.id,
    playerId: row.playerId,
    currency: row.currency,
    balance: toMoney(row.balanceAmount, row.currency),
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

export function toWalletUpdate(wallet: Wallet): WalletUpdate {
  return {
    currency: wallet.currency,
    balanceAmount: toAmountColumn(wallet.balance),
    version: wallet.version,
    updatedAt: wallet.updatedAt,
  };
}

export function toWalletRow(wallet: Wallet): WalletRow {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    createdAt: wallet.createdAt,
    ...toWalletUpdate(wallet),
  };
}
