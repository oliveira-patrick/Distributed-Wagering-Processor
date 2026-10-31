/*
  Os quatro eventos de integração que o sistema publica.

  Todos usam a `walletId` como `aggregateId`, e não o id da transação. A razão
  é a fila: o `aggregateId` é o que o publicador entrega como `MessageGroupId`,
  e o grupo de ordenação é a wallet — é ela a unidade de concorrência e a
  fronteira de consistência. Com o id da transação no lugar, cada evento viraria
  o próprio grupo e a ordenação relativa entre eventos da mesma wallet se
  perderia. O id da transação viaja em `data`, onde o consumidor o encontra.
*/
export {
  WagerTransactionPendingReference,
  type WagerTransactionPendingReferenceData,
} from './wager-transaction-pending-reference.event';
export {
  WagerTransactionProcessed,
  type WagerTransactionProcessedData,
} from './wager-transaction-processed.event';
export {
  WagerTransactionRejected,
  type WagerTransactionRejectedData,
} from './wager-transaction-rejected.event';
export {
  WalletBalanceChanged,
  type WalletBalanceChangedData,
} from './wallet-balance-changed.event';
export {
  describeTransaction,
  type WagerTransactionDescriptor,
} from './wager-transaction.descriptor';
