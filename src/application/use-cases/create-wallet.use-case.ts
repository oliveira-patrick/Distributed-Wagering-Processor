import { OutboxMessage } from '../../domain/messaging/outbox-message';
import {
  WagerTransactionProcessed,
  WalletBalanceChanged,
} from '../../domain/messaging/events';
import type { EventContext } from '../../domain/messaging/integration-event';
import { FailureCode } from '../../domain/shared/failure-code';
import { hashWagerPayload } from '../../domain/wagering/wager-payload-hash';
import { WagerTransaction } from '../../domain/wagering/wager-transaction';
import { WagerTransactionKind } from '../../domain/wagering/wager-transaction-kind';
import { Wallet } from '../../domain/wallet/wallet';
import type { WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry';
import type { CreateWalletCommand } from '../contracts/create-wallet.command';
import type { Clock, IdGenerator } from '../ports/system.port';
import type { Repositories, UnitOfWork } from '../ports/unit-of-work';
import { refused } from './refusal';
import type { Refusal } from './refusal';

/*
  Provedor das transações internas.

  A abertura de wallet gera uma transação `OPENING` que não veio de provedor
  nenhum, e as colunas de identificação externa são `not null`. Preenchê-las
  com um valor reservado mantém o schema estrito para os 99% dos casos, em vez
  de torná-las anuláveis por causa de um caso interno. Interpretação adicional,
  declarada aqui e no `ARCHITECTURE.md`.
*/
export const INTERNAL_PROVIDER_ID = 'internal';

export type CreateWalletResult =
  { readonly outcome: 'created'; readonly wallet: Wallet } | Refusal;

/*
  `POST /wallets`.

  Saldo inicial maior que zero gera a transação `OPENING` e o lançamento
  `CREDIT` **na mesma transação SQL**. Saldo zero não gera
  nenhum dos dois: um movimento de zero não existe, e tanto
  `WagerTransaction.create` quanto o `check` da coluna recusam valor não
  positivo.

  A `version` da resposta é `1` mesmo com saldo positivo. O contrato é
  explícito, e o agregado foi desenhado para isso: o crédito de abertura faz
  parte da criação, não é um movimento posterior.
*/
export class CreateWalletUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute(
    command: CreateWalletCommand,
    correlationId: string,
  ): Promise<CreateWalletResult> {
    return this.unitOfWork.run(async (repositories) => {
      const now = this.clock.now();

      const { wallet, openingEntry } = Wallet.open({
        id: this.ids.next(),
        playerId: command.playerId,
        initialBalance: command.initialBalance,
        openingTransactionId: this.ids.next(),
        openingEntryId: this.ids.next(),
        now,
      });
      /*
        A unicidade de `(player_id, currency)` no schema é quem decide. Duas
        requisições concorrentes para o mesmo par chegam as duas aqui, e só uma
        insere — consultar antes devolveria "não existe" para ambas.
      */
      if (!(await repositories.wallets.tryInsert(wallet))) {
        return refused(
          FailureCode.WALLET_ALREADY_EXISTS,
          `já existe wallet para o player ${command.playerId} em ${wallet.currency}`,
        );
      }

      if (openingEntry !== undefined) {
        await this.recordOpening(
          repositories,
          wallet,
          openingEntry,
          now,
          correlationId,
        );
      }

      return { outcome: 'created', wallet };
    });
  }

  /*
    Transação `OPENING`, lançamento e eventos, no mesmo commit da wallet.

    Os eventos saem porque as regras de publicação se aplicam como escritas:
    o crédito de abertura **é** uma transação aplicada e **é** uma mudança de
    saldo. Um consumidor que reconstrói saldo a partir dos eventos ficaria com
    a wallet nascendo em zero se a abertura não fosse publicada. Interpretação
    adicional, declarada.
  */
  private async recordOpening(
    repositories: Repositories,
    wallet: Wallet,
    openingEntry: WalletLedgerEntry,
    now: Date,
    correlationId: string,
  ): Promise<void> {
    const reference = `opening:${wallet.id}`;

    const opening = WagerTransaction.create({
      id: openingEntry.transactionId,
      providerId: INTERNAL_PROVIDER_ID,
      externalTransactionId: reference,
      idempotencyKey: reference,
      payloadHash: hashWagerPayload({
        providerId: INTERNAL_PROVIDER_ID,
        externalTransactionId: reference,
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: reference,
        gameId: INTERNAL_PROVIDER_ID,
        kind: WagerTransactionKind.Opening,
        money: openingEntry.money,
        referenceExternalTransactionId: undefined,
      }),
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: reference,
      gameId: INTERNAL_PROVIDER_ID,
      kind: WagerTransactionKind.Opening,
      money: openingEntry.money,
      createdAt: now,
    });
    opening.markProcessed(undefined, now, wallet.balance);

    if (!(await repositories.transactions.tryInsert(opening)).inserted) {
      /*
        A wallet acabou de ser inserida com sucesso, e a chave da abertura é
        derivada do id dela. Colisão aqui significa id repetido.
      */
      throw new Error(
        `colisão na transação de abertura da wallet ${wallet.id}`,
      );
    }

    await repositories.ledger.append(openingEntry);

    await repositories.outbox.enqueue(
      OutboxMessage.enqueue(
        WagerTransactionProcessed.from(
          opening,
          this.eventContext(correlationId, now, opening.id),
        ),
      ),
    );
    await repositories.outbox.enqueue(
      OutboxMessage.enqueue(
        WalletBalanceChanged.from(
          wallet,
          openingEntry,
          this.eventContext(correlationId, now, opening.id),
        ),
      ),
    );
  }

  /*
    Um `eventId` novo por evento, correlação compartilhada.

    `causationId` é o id da transação que originou o evento: é por ele que se
    liga `WagerTransactionProcessed` e `WalletBalanceChanged` ao mesmo fato,
    enquanto `correlationId` liga tudo à requisição que entrou.
  */
  private eventContext(
    correlationId: string,
    occurredAt: Date,
    causationId: string,
  ): EventContext {
    return {
      eventId: this.ids.next(),
      correlationId,
      causationId,
      occurredAt,
    };
  }
}
