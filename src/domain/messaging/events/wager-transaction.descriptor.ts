import type { MoneyProps } from '../../money/money';
import type { WagerTransaction } from '../../wagering/wager-transaction';
import type { WagerTransactionKind } from '../../wagering/wager-transaction-kind';

/*
  Identificação que todo evento de transação carrega.

  Existe para que os quatro eventos de integração tenham o **mesmo**
  conjunto de campos de identificação, na mesma forma. Um consumidor que
  saiba ler um sabe ler os outros, e correlacionar `WagerTransactionProcessed`
  com `WalletBalanceChanged` não exige conhecer duas convenções.
*/
export interface WagerTransactionDescriptor {
  readonly transactionId: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly money: MoneyProps;
}

/*
  `money.toJSON()` é chamado **pelo nome**, de propósito.

  A serialização automática é rede de segurança, não o mecanismo de contrato:
  o payload do evento precisa ser JSON estável e versionável, e deixar a forma
  interna de `Money` decidi-lo por acidente é o oposto disso. Aqui a conversão
  para string decimal é uma decisão visível, com teste de formato próprio.
*/
export function describeTransaction(
  transaction: WagerTransaction,
): WagerTransactionDescriptor {
  return {
    transactionId: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    money: transaction.money.toJSON(),
  };
}
