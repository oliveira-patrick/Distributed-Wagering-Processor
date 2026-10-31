import { EntitySchema } from '@mikro-orm/core';

/*
  Linha de `wallets`.

  Campos públicos e mutáveis, sem invariante nenhuma: o agregado `Wallet` é
  quem protege as regras, e esta classe só carrega valores entre o driver e o
  mapper. `balanceAmount` é string porque a coluna é `numeric(20, 2)` e
  precisa continuar decimal exato de ponta a ponta — o driver do PostgreSQL
  entrega `numeric` como string justamente para não perder precisão, e
  converter para `number` aqui jogaria fora a exatidão do valor.
*/
export class WalletRow {
  id!: string;
  playerId!: string;
  currency!: string;
  balanceAmount!: string;
  version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}

export const walletSchema = new EntitySchema<WalletRow>({
  class: WalletRow,
  tableName: 'wallets',
  properties: {
    id: { type: 'uuid', primary: true },
    playerId: { type: 'string' },
    currency: { type: 'string', columnType: 'char(3)' },
    balanceAmount: { type: 'string', columnType: 'numeric(20,2)' },
    /*
      `version` do domínio, não o campo de lock otimista do MikroORM. Quem
      incrementa é o agregado; marcá-lo como `version: true` entregaria o
      controle ao ORM e criaria uma segunda fonte da verdade sobre o mesmo
      número. A arbitragem de concorrência é o lock pessimista de linha — ver ADR-004.
    */
    version: { type: 'number' },
    createdAt: { type: 'datetime', columnType: 'timestamptz' },
    updatedAt: { type: 'datetime', columnType: 'timestamptz' },
  },
});
