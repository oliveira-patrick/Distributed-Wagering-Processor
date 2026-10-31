/*
  Modelos de persistência — uma classe por tabela, separada do domínio.

  O MikroORM mapeia **estas** classes, não as do domínio, e mappers fazem a
  tradução entre as duas. Três razões, na ordem em que pesaram:

  1. O domínio não deve depender de tipo monetário de ORM nem de decorator
     de framework. Com `EntitySchema` o
     mapeamento já é externo à classe, sem decorator — mas mapear o domínio
     direto significaria desenhar o domínio em torno do que o ORM consegue
     hidratar.
  2. As entidades de domínio têm construtor privado e campos `_privados`
     mutáveis atrás de getters. O ORM precisa instanciar sem passar pelo
     construtor e escrever nos campos; conceder isso exigiria afrouxar
     exatamente as barreiras que tornam as invariantes estruturais.
  3. `Money` é value object com `bigint` interno e moeda. Na linha ele é
     `numeric(20, 2)` mais a moeda da linha — uma correspondência que não é
     um para um e que o mapper expressa melhor que um custom type.

  O que se mantém: Unit of Work, Identity Map, `transactional()` e
  `LockMode.PESSIMISTIC_WRITE` — as razões pelas quais o ADR-003 escolheu
  MikroORM. O que se paga: uma classe e um mapper por tabela, mais a
  obrigação de manter os dois lados em sincronia, coberta por teste de
  round-trip contra PostgreSQL real.

  O nome das colunas vem da `UnderscoreNamingStrategy`, declarada na
  configuração: `balanceAmount` vira `balance_amount`. Nenhuma propriedade
  precisa de `fieldName` porque nenhuma foge dessa regra, e o teste de
  round-trip é o que prova que a conversão é a esperada.
*/
import { inboxMessageSchema } from './inbox-message.row';
import { outboxMessageSchema } from './outbox-message.row';
import { wagerTransactionSchema } from './wager-transaction.row';
import { walletLedgerEntrySchema } from './wallet-ledger-entry.row';
import { walletSchema } from './wallet.row';

export { InboxMessageRow, inboxMessageSchema } from './inbox-message.row';
export { OutboxMessageRow, outboxMessageSchema } from './outbox-message.row';
export {
  WagerTransactionRow,
  wagerTransactionSchema,
} from './wager-transaction.row';
export {
  WalletLedgerEntryRow,
  walletLedgerEntrySchema,
} from './wallet-ledger-entry.row';
export { WalletRow, walletSchema } from './wallet.row';

// Tudo que o MikroORM precisa descobrir.
export const persistenceEntities = [
  walletSchema,
  wagerTransactionSchema,
  walletLedgerEntrySchema,
  inboxMessageSchema,
  outboxMessageSchema,
];
