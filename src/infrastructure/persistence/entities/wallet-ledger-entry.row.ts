import { EntitySchema } from '@mikro-orm/core';

/*
  Linha de `wallet_ledger_entries`.

  Uma coluna `currency` para os três valores da linha: um lançamento move um
  valor numa moeda, com saldo antes e depois na mesma moeda. Ver ADR-006 e o
  comentário gravado na própria coluna pela migration.

  O lado do banco recusa `update`, `delete` e `truncate` por trigger. Aqui
  não existe operação de escrita além da inserção porque nenhum repositório
  oferece uma — e, se alguém adicionar, o banco recusa.
*/
export class WalletLedgerEntryRow {
  id!: string;
  walletId!: string;
  transactionId!: string;
  direction!: string;
  currency!: string;
  moneyAmount!: string;
  balanceBeforeAmount!: string;
  balanceAfterAmount!: string;
  createdAt!: Date;
}

export const walletLedgerEntrySchema = new EntitySchema<WalletLedgerEntryRow>({
  class: WalletLedgerEntryRow,
  tableName: 'wallet_ledger_entries',
  properties: {
    id: { type: 'uuid', primary: true },
    walletId: { type: 'uuid' },
    transactionId: { type: 'uuid' },
    direction: { type: 'string' },
    currency: { type: 'string', columnType: 'char(3)' },
    moneyAmount: { type: 'string', columnType: 'numeric(20,2)' },
    balanceBeforeAmount: { type: 'string', columnType: 'numeric(20,2)' },
    balanceAfterAmount: { type: 'string', columnType: 'numeric(20,2)' },
    createdAt: { type: 'datetime', columnType: 'timestamptz' },
  },
});
