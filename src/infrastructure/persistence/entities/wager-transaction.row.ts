import { EntitySchema } from '@mikro-orm/core';

/*
  Linha de `wager_transactions`.

  `walletId` e `referenceTransactionId` são colunas escalares, não relações
  do ORM. A fronteira do agregado é a wallet, e o caso de uso carrega
  explicitamente o que precisa, sob lock: relação mapeada convidaria o ORM a
  buscar grafo por conta própria, fora do lock e fora da transação onde a
  decisão financeira acontece. As foreign keys continuam existindo — são
  garantidas pelo schema, não pelo mapeamento.
*/
export class WagerTransactionRow {
  id!: string;
  providerId!: string;
  externalTransactionId!: string;
  idempotencyKey!: string;
  payloadHash!: string;
  walletId!: string;
  playerId!: string;
  roundId!: string;
  gameId!: string;
  kind!: string;
  currency!: string;
  moneyAmount!: string;
  referenceExternalTransactionId!: string | null;
  status!: string;
  referenceTransactionId!: string | null;
  failureCode!: string | null;
  processedAt!: Date | null;
  observedBalanceAmount!: string | null;
  referenceAttempts!: number;
  nextReferenceAttemptAt!: Date | null;
  createdAt!: Date;
}

export const wagerTransactionSchema = new EntitySchema<WagerTransactionRow>({
  class: WagerTransactionRow,
  tableName: 'wager_transactions',
  properties: {
    id: { type: 'uuid', primary: true },
    providerId: { type: 'string' },
    externalTransactionId: { type: 'string' },
    idempotencyKey: { type: 'string' },
    payloadHash: { type: 'string', columnType: 'char(64)' },
    walletId: { type: 'uuid' },
    playerId: { type: 'string' },
    roundId: { type: 'string' },
    gameId: { type: 'string' },
    kind: { type: 'string' },
    currency: { type: 'string', columnType: 'char(3)' },
    moneyAmount: { type: 'string', columnType: 'numeric(20,2)' },
    referenceExternalTransactionId: { type: 'string', nullable: true },
    status: { type: 'string' },
    referenceTransactionId: { type: 'uuid', nullable: true },
    failureCode: { type: 'string', nullable: true },
    processedAt: {
      type: 'datetime',
      columnType: 'timestamptz',
      nullable: true,
    },
    observedBalanceAmount: {
      type: 'string',
      columnType: 'numeric(20,2)',
      nullable: true,
    },
    referenceAttempts: { type: 'number' },
    nextReferenceAttemptAt: {
      type: 'datetime',
      columnType: 'timestamptz',
      nullable: true,
    },
    createdAt: { type: 'datetime', columnType: 'timestamptz' },
  },
});
