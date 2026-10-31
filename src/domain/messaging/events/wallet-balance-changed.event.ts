import type { MoneyProps } from '../../money/money';
import type { LedgerDirection } from '../../wallet/ledger-direction';
import type { Wallet } from '../../wallet/wallet';
import type { WalletLedgerEntry } from '../../wallet/wallet-ledger-entry';
import { IntegrationEvent } from '../integration-event';
import type { EventContext } from '../integration-event';

export interface WalletBalanceChangedData {
  readonly walletId: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly money: MoneyProps;
  readonly balanceBefore: MoneyProps;
  readonly balanceAfter: MoneyProps;
  readonly walletVersion: number;
}

/*
  O saldo mudou — publicado **somente** quando ele muda de fato.

  `LOSS` não gera este evento, porque não move saldo. A diferença entre "a
  transação foi aplicada" e "o saldo mudou" é justamente o que separa este
  evento de `WagerTransactionProcessed`, e colapsá-los faria um consumidor que
  acompanha saldo receber notificação de `LOSS` sem nada para atualizar.

  Os campos carregam `MoneyProps`, nunca instâncias de `Money`: o payload
  precisa ser JSON estável e versionável.
*/
export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  static from(
    wallet: Wallet,
    entry: WalletLedgerEntry,
    ctx: EventContext,
  ): WalletBalanceChanged {
    return new WalletBalanceChanged({
      eventId: ctx.eventId,
      /*
        A wallet é o agregado, e também o grupo de ordenação na fila FIFO:
        é daqui que o publicador tira o `MessageGroupId`.
      */
      aggregateId: wallet.id,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: ctx.occurredAt,
      data: {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: wallet.version,
      },
    });
  }
}
