/*
  Ida e volta entre domínio e PostgreSQL REAL — nenhum mock.

    bun run infra:up && bun run test:integration

  Dois grupos de garantia aqui. O primeiro é que nada se perde na travessia:
  `Money` com os 18 dígitos inteiros do limite, estados opcionais presentes e
  ausentes, `jsonb` do envelope. O segundo é comportamental, e é o mais
  importante: a estratégia de idempotência depende de inserir primeiro e
  tratar a colisão como caminho normal, o que no PostgreSQL só funciona se a
  tentativa estiver isolada num savepoint — do contrário a colisão abortaria
  a transação em que a resposta de replay precisa ser montada.
*/
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import { MAX_AMOUNT, Money } from '../../src/domain/money/money';
import { InboxMessage } from '../../src/domain/messaging/inbox-message';
import { IntegrationEvent } from '../../src/domain/messaging/integration-event';
import type { IntegrationEventProps } from '../../src/domain/messaging/integration-event';
import { OutboxMessage } from '../../src/domain/messaging/outbox-message';
import { FailureCode } from '../../src/domain/shared/failure-code';
import { WagerTransaction } from '../../src/domain/wagering/wager-transaction';
import { WagerTransactionKind } from '../../src/domain/wagering/wager-transaction-kind';
import { WagerTransactionStatus } from '../../src/domain/wagering/wager-transaction-status';
import { LedgerDirection } from '../../src/domain/wallet/ledger-direction';
import { Wallet } from '../../src/domain/wallet/wallet';
import { rebuildBalance } from '../../src/domain/wallet/wallet-ledger-entry';
import type { Repositories } from '../../src/application/ports/unit-of-work';
import { TransactionConflict } from '../../src/application/ports/wager-transaction.repository';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm.unit-of-work';
import { createTestDatabase } from './support/test-database';
import type { TestDatabase } from './support/test-database';

let db: TestDatabase;
let uow: MikroOrmUnitOfWork;

const NOW = new Date('2026-10-30T12:00:00.000Z');
const LATER = new Date('2026-10-30T12:05:00.000Z');

function brl(amount: string): Money {
  return Money.from({ amount, currency: 'BRL' });
}

function hash(): string {
  return randomUUID().replaceAll('-', '').padEnd(64, '0').slice(0, 64);
}

interface OpenedWallet {
  readonly wallet: Wallet;
  readonly openingTransaction: WagerTransaction;
}

// Abre a wallet e grava wallet, transação `OPENING` e lançamento.
async function openWallet(
  repositories: Repositories,
  initial: string,
  currency = 'BRL',
): Promise<OpenedWallet> {
  const walletId = randomUUID();
  const openingTransactionId = randomUUID();
  const initialBalance = Money.from({ amount: initial, currency });

  const { wallet, openingEntry } = Wallet.open({
    id: walletId,
    playerId: randomUUID(),
    initialBalance,
    openingTransactionId,
    openingEntryId: randomUUID(),
    now: NOW,
  });

  const openingTransaction = WagerTransaction.create({
    id: openingTransactionId,
    providerId: 'internal',
    externalTransactionId: `opening:${walletId}`,
    idempotencyKey: `opening:${walletId}`,
    payloadHash: hash(),
    walletId,
    playerId: wallet.playerId,
    roundId: `opening:${walletId}`,
    gameId: 'internal',
    kind: WagerTransactionKind.Opening,
    money: initialBalance,
    createdAt: NOW,
  });
  openingTransaction.markProcessed(undefined, NOW, initialBalance);

  expect(await repositories.wallets.tryInsert(wallet)).toBe(true);
  expect(await repositories.transactions.tryInsert(openingTransaction)).toEqual(
    { inserted: true },
  );
  if (openingEntry === undefined) {
    throw new Error('openWallet exige saldo positivo; use openEmptyWallet');
  }
  await repositories.ledger.append(openingEntry);

  return { wallet, openingTransaction };
}

/*
  Abre a wallet com saldo zero.

  Caminho separado porque saldo inicial zero não tem lançamento de abertura
  **nem** transação `OPENING`: um movimento de zero não existe, e
  `WagerTransaction.create` recusa valor não positivo. É a mesma distinção
  que o caso de uso de criação de wallet terá de fazer.
*/
async function openEmptyWallet(
  repositories: Repositories,
  currency = 'BRL',
): Promise<Wallet> {
  const { wallet, openingEntry } = Wallet.open({
    id: randomUUID(),
    playerId: randomUUID(),
    initialBalance: Money.zero(currency),
    openingTransactionId: randomUUID(),
    openingEntryId: randomUUID(),
    now: NOW,
  });

  expect(openingEntry).toBeUndefined();
  expect(await repositories.wallets.tryInsert(wallet)).toBe(true);

  return wallet;
}

function bet(
  walletId: string,
  playerId: string,
  amount: string,
): WagerTransaction {
  return WagerTransaction.create({
    id: randomUUID(),
    providerId: 'provider-a',
    externalTransactionId: randomUUID(),
    idempotencyKey: randomUUID(),
    payloadHash: hash(),
    walletId,
    playerId,
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: WagerTransactionKind.Bet,
    money: brl(amount),
    createdAt: NOW,
  });
}

interface ProbeData {
  readonly walletId: string;
  readonly money: { readonly amount: string; readonly currency: string };
}

class ProbeEvent extends IntegrationEvent<ProbeData> {
  readonly eventType = 'WalletBalanceChanged';
  readonly version = 1;

  static from(props: IntegrationEventProps<ProbeData>): ProbeEvent {
    return new ProbeEvent(props);
  }
}

beforeAll(async () => {
  db = await createTestDatabase('mapping');
  uow = new MikroOrmUnitOfWork(db.orm.em);
}, 120_000);

afterAll(async () => {
  await db.close();
});

describe('Money na travessia', () => {
  it('preserva o limite de 18 dígitos inteiros sem perder centavo', async () => {
    // É o teste que prova que `numeric(20, 2)` e `bigint` de centavos
    // concordam no extremo. Um `double` falharia aqui muito antes.
    const reread = await uow.run(async (repositories) => {
      const { wallet } = await openWallet(repositories, MAX_AMOUNT);
      return repositories.wallets.findById(wallet.id);
    });

    expect(reread?.balance.toString()).toBe(MAX_AMOUNT);
    expect(reread?.balance.toString()).toBe('999999999999999999.99');
  });

  it('normaliza a escala na gravação', async () => {
    /*
      `Money.from` já normaliza; o que se prova aqui é que a coluna devolve a
      string canônica, e não o que o chamador digitou.
    */
    for (const [entrada, esperado] of [
      ['25', '25.00'],
      ['25.0', '25.00'],
      ['0025.00', '25.00'],
      ['0.01', '0.01'],
    ] as const) {
      const reread = await uow.run(async (repositories) => {
        const { wallet } = await openWallet(repositories, entrada);
        return repositories.wallets.findById(wallet.id);
      });

      expect(reread?.balance.toString()).toBe(esperado);
    }
  });

  it('grava zero com a escala completa', async () => {
    const reread = await uow.run(async (repositories) => {
      const wallet = await openEmptyWallet(repositories);
      return repositories.wallets.findById(wallet.id);
    });

    expect(reread?.balance.toString()).toBe('0.00');
    expect(reread?.balance.isZero()).toBe(true);
  });

  it('reidrata a moeda da linha, não um default', async () => {
    const reread = await uow.run(async (repositories) => {
      const { wallet } = await openWallet(repositories, '10.00', 'USD');
      return repositories.wallets.findById(wallet.id);
    });

    expect(reread?.currency).toBe('USD');
    expect(reread?.balance.currency).toBe('USD');
  });
});

describe('Wallet', () => {
  it('volta do banco com o mesmo estado', async () => {
    const { original, reread } = await uow.run(async (repositories) => {
      const { wallet } = await openWallet(repositories, '1000.00');
      const found = await repositories.wallets.findById(wallet.id);
      return { original: wallet, reread: found };
    });

    expect(reread).toBeDefined();
    expect(reread?.id).toBe(original.id);
    expect(reread?.playerId).toBe(original.playerId);
    expect(reread?.currency).toBe('BRL');
    expect(reread?.balance.toString()).toBe('1000.00');
    expect(reread?.version).toBe(1);
    expect(reread?.createdAt.getTime()).toBe(NOW.getTime());
  });

  it('persiste o movimento e a version', async () => {
    const reread = await uow.run(async (repositories) => {
      const { wallet } = await openWallet(repositories, '100.00');
      const transaction = bet(wallet.id, wallet.playerId, '30.00');
      await repositories.transactions.tryInsert(transaction);

      const locked = await repositories.wallets.findByIdForUpdate(wallet.id);
      expect(locked).toBeDefined();
      if (locked === undefined) throw new Error('wallet não encontrada');

      const entry = locked.debit({
        entryId: randomUUID(),
        transactionId: transaction.id,
        money: brl('30.00'),
        now: LATER,
      });
      await repositories.ledger.append(entry);
      await repositories.wallets.save(locked);

      return repositories.wallets.findById(wallet.id);
    });

    expect(reread?.balance.toString()).toBe('70.00');
    expect(reread?.version).toBe(2);
    expect(reread?.updatedAt.getTime()).toBe(LATER.getTime());
  });

  it('encontra pela chave natural player e moeda', async () => {
    const found = await uow.run(async (repositories) => {
      const { wallet } = await openWallet(repositories, '50.00');
      return repositories.wallets.findByPlayerAndCurrency(
        wallet.playerId,
        'BRL',
      );
    });

    expect(found?.balance.toString()).toBe('50.00');
  });

  it('recusa segunda wallet para o mesmo par player e moeda', async () => {
    const outcome = await uow.run(async (repositories) => {
      const { wallet } = await openWallet(repositories, '10.00');

      const duplicate = Wallet.open({
        id: randomUUID(),
        playerId: wallet.playerId,
        initialBalance: brl('99.00'),
        openingTransactionId: randomUUID(),
        openingEntryId: randomUUID(),
        now: NOW,
      });

      return repositories.wallets.tryInsert(duplicate.wallet);
    });

    expect(outcome).toBe(false);
  });
});

describe('WagerTransaction', () => {
  it('volta com os campos opcionais ausentes', async () => {
    const reread = await uow.run(async (repositories) => {
      const { wallet } = await openWallet(repositories, '100.00');
      const transaction = bet(wallet.id, wallet.playerId, '25.00');
      await repositories.transactions.tryInsert(transaction);
      return repositories.transactions.findById(transaction.id);
    });

    expect(reread?.status).toBe(WagerTransactionStatus.Pending);
    expect(reread?.money.toString()).toBe('25.00');
    expect(reread?.referenceExternalTransactionId).toBeUndefined();
    expect(reread?.referenceTransactionId).toBeUndefined();
    expect(reread?.failureCode).toBeUndefined();
    expect(reread?.processedAt).toBeUndefined();
    expect(reread?.observedBalance).toBeUndefined();
    expect(reread?.referenceAttempts).toBe(0);
    expect(reread?.nextReferenceAttemptAt).toBeUndefined();
  });

  it('persiste a transição para PROCESSED com o saldo observado', async () => {
    const reread = await uow.run(async (repositories) => {
      const { wallet } = await openWallet(repositories, '100.00');
      const transaction = bet(wallet.id, wallet.playerId, '25.00');
      await repositories.transactions.tryInsert(transaction);

      transaction.markProcessed(undefined, LATER, brl('75.00'));
      await repositories.transactions.save(transaction);

      return repositories.transactions.findById(transaction.id);
    });

    expect(reread?.status).toBe(WagerTransactionStatus.Processed);
    expect(reread?.processedAt?.getTime()).toBe(LATER.getTime());
    expect(reread?.observedBalance?.toString()).toBe('75.00');
    expect(reread?.isTerminal()).toBe(true);
  });

  it('persiste a recusa com o código de falha', async () => {
    const reread = await uow.run(async (repositories) => {
      const { wallet } = await openWallet(repositories, '10.00');
      const transaction = bet(wallet.id, wallet.playerId, '80.00');
      await repositories.transactions.tryInsert(transaction);

      transaction.reject(FailureCode.INSUFFICIENT_FUNDS, LATER, brl('10.00'));
      await repositories.transactions.save(transaction);

      return repositories.transactions.findById(transaction.id);
    });

    expect(reread?.status).toBe(WagerTransactionStatus.Rejected);
    expect(reread?.failureCode).toBe(FailureCode.INSUFFICIENT_FUNDS);
    expect(reread?.observedBalance?.toString()).toBe('10.00');
  });

  it('persiste a espera por referência e aparece na fila do worker', async () => {
    const { transactionId, due } = await uow.run(async (repositories) => {
      const { wallet } = await openWallet(repositories, '100.00');

      const refund = WagerTransaction.create({
        id: randomUUID(),
        providerId: 'provider-a',
        externalTransactionId: randomUUID(),
        idempotencyKey: randomUUID(),
        payloadHash: hash(),
        walletId: wallet.id,
        playerId: wallet.playerId,
        roundId: 'round-987',
        gameId: 'fortune-chimp',
        kind: WagerTransactionKind.Refund,
        money: brl('25.00'),
        referenceExternalTransactionId: 'transaction-100',
        createdAt: NOW,
      });
      await repositories.transactions.tryInsert(refund);

      refund.markPendingReference(LATER);
      await repositories.transactions.save(refund);

      return {
        transactionId: refund.id,
        due: await repositories.transactions.findDueForReference(
          new Date(LATER.getTime() + 1),
          10,
        ),
      };
    });

    expect(due.map((item) => item.id)).toContain(transactionId);
    const found = due.find((item) => item.id === transactionId);
    expect(found?.status).toBe(WagerTransactionStatus.PendingReference);
    expect(found?.referenceAttempts).toBe(1);
    expect(found?.nextReferenceAttemptAt?.getTime()).toBe(LATER.getTime());
  });

  it('não devolve na fila quem ainda não venceu', async () => {
    const { transactionId, due } = await uow.run(async (repositories) => {
      const { wallet } = await openWallet(repositories, '100.00');

      const refund = WagerTransaction.create({
        id: randomUUID(),
        providerId: 'provider-a',
        externalTransactionId: randomUUID(),
        idempotencyKey: randomUUID(),
        payloadHash: hash(),
        walletId: wallet.id,
        playerId: wallet.playerId,
        roundId: 'round-987',
        gameId: 'fortune-chimp',
        kind: WagerTransactionKind.Refund,
        money: brl('25.00'),
        referenceExternalTransactionId: 'transaction-200',
        createdAt: NOW,
      });
      await repositories.transactions.tryInsert(refund);
      refund.markPendingReference(new Date(LATER.getTime() + 60_000));
      await repositories.transactions.save(refund);

      return {
        transactionId: refund.id,
        due: await repositories.transactions.findDueForReference(LATER, 10),
      };
    });

    /*
      Pela identidade, e não pela contagem: a fila é global e outros casos
      deste arquivo também deixam transações aguardando referência.
    */
    expect(due.map((item) => item.id)).not.toContain(transactionId);
  });
});

describe('idempotência com savepoint', () => {
  it('trata a colisão como caminho normal e mantém a transação utilizável', async () => {
    /*
      O caso central. Se a inserção não estivesse isolada num savepoint, a
      colisão abortaria a transação e tudo depois dela falharia com "current
      transaction is aborted" — e a resposta de replay, que precisa ler a
      transação original, nunca poderia ser montada.
    */
    const { first, second, found, committed } = await uow.run(
      async (repositories) => {
        const { wallet } = await openWallet(repositories, '100.00');
        const transaction = bet(wallet.id, wallet.playerId, '25.00');

        const firstOutcome =
          await repositories.transactions.tryInsert(transaction);

        const duplicate = WagerTransaction.create({
          id: randomUUID(),
          providerId: transaction.providerId,
          externalTransactionId: randomUUID(),
          idempotencyKey: transaction.idempotencyKey,
          payloadHash: hash(),
          walletId: wallet.id,
          playerId: wallet.playerId,
          roundId: 'round-987',
          gameId: 'fortune-chimp',
          kind: WagerTransactionKind.Bet,
          money: brl('25.00'),
          createdAt: NOW,
        });
        const secondOutcome =
          await repositories.transactions.tryInsert(duplicate);

        return {
          first: firstOutcome,
          second: secondOutcome,
          // Leitura **depois** da colisão: é o que prova que a transação
          // sobreviveu.
          found: await repositories.transactions.findByIdempotencyKey(
            transaction.idempotencyKey,
          ),
          committed: transaction.id,
        };
      },
    );

    expect(first).toEqual({ inserted: true });
    expect(second).toEqual({
      inserted: false,
      conflict: TransactionConflict.IdempotencyKey,
    });
    expect(found?.id).toBe(committed);

    // E o commit aconteceu: a colisão não levou a transação inteira embora.
    const persisted = await uow.run(async (repositories) =>
      repositories.transactions.findById(committed),
    );
    expect(persisted).toBeDefined();
  });

  it('distingue colisão de id externo de colisão de chave de idempotência', async () => {
    const outcome = await uow.run(async (repositories) => {
      const { wallet } = await openWallet(repositories, '100.00');
      const transaction = bet(wallet.id, wallet.playerId, '25.00');
      await repositories.transactions.tryInsert(transaction);

      const resent = WagerTransaction.create({
        id: randomUUID(),
        providerId: transaction.providerId,
        externalTransactionId: transaction.externalTransactionId,
        idempotencyKey: randomUUID(),
        payloadHash: hash(),
        walletId: wallet.id,
        playerId: wallet.playerId,
        roundId: 'round-987',
        gameId: 'fortune-chimp',
        kind: WagerTransactionKind.Bet,
        money: brl('25.00'),
        createdAt: NOW,
      });

      return repositories.transactions.tryInsert(resent);
    });

    expect(outcome).toEqual({
      inserted: false,
      conflict: TransactionConflict.ProviderExternalId,
    });
  });

  it('reconhece a reversão duplicada como conflito próprio', async () => {
    const outcome = await uow.run(async (repositories) => {
      const { wallet } = await openWallet(repositories, '100.00');
      const reference = randomUUID();

      const rollbackProps = {
        walletId: wallet.id,
        playerId: wallet.playerId,
        roundId: 'round-987',
        gameId: 'fortune-chimp',
        kind: WagerTransactionKind.Rollback,
        money: brl('25.00'),
        referenceExternalTransactionId: reference,
        createdAt: NOW,
      } as const;

      await repositories.transactions.tryInsert(
        WagerTransaction.create({
          ...rollbackProps,
          id: randomUUID(),
          providerId: 'provider-a',
          externalTransactionId: randomUUID(),
          idempotencyKey: randomUUID(),
          payloadHash: hash(),
        }),
      );

      return repositories.transactions.tryInsert(
        WagerTransaction.create({
          ...rollbackProps,
          id: randomUUID(),
          providerId: 'provider-a',
          externalTransactionId: randomUUID(),
          idempotencyKey: randomUUID(),
          payloadHash: hash(),
        }),
      );
    });

    expect(outcome).toEqual({
      inserted: false,
      conflict: TransactionConflict.AlreadyReversed,
    });
  });
});

describe('ledger', () => {
  it('volta com a aritmética e a direção intactas', async () => {
    const entries = await uow.run(async (repositories) => {
      const { wallet } = await openWallet(repositories, '100.00');
      const transaction = bet(wallet.id, wallet.playerId, '30.00');
      await repositories.transactions.tryInsert(transaction);

      const locked = await repositories.wallets.findByIdForUpdate(wallet.id);
      if (locked === undefined) throw new Error('wallet não encontrada');

      await repositories.ledger.append(
        locked.debit({
          entryId: randomUUID(),
          transactionId: transaction.id,
          money: brl('30.00'),
          now: LATER,
        }),
      );
      await repositories.wallets.save(locked);

      return repositories.ledger.listByWallet(wallet.id);
    });

    expect(entries).toHaveLength(2);

    const [abertura, debito] = entries;
    expect(abertura?.direction).toBe(LedgerDirection.Credit);
    expect(abertura?.money.toString()).toBe('100.00');
    expect(abertura?.balanceBefore.toString()).toBe('0.00');
    expect(abertura?.balanceAfter.toString()).toBe('100.00');

    expect(debito?.direction).toBe(LedgerDirection.Debit);
    expect(debito?.balanceBefore.toString()).toBe('100.00');
    expect(debito?.balanceAfter.toString()).toBe('70.00');
    expect(debito?.isBalanced()).toBe(true);
  });

  it('a soma no banco concorda com a soma no domínio', async () => {
    /*
      A invariante global do saldo, com as duas implementações que o
      sistema usa: `sum` em `numeric` dentro do PostgreSQL e `rebuildBalance`
      somando `Money` em memória. Se divergirem, a reconciliação mente.
    */
    const { totais, noDominio, saldo } = await uow.run(async (repositories) => {
      const { wallet } = await openWallet(repositories, '100.00');

      const locked = await repositories.wallets.findByIdForUpdate(wallet.id);
      if (locked === undefined) throw new Error('wallet não encontrada');

      for (const [amount, direction] of [
        ['30.00', LedgerDirection.Debit],
        ['5.50', LedgerDirection.Credit],
        ['0.50', LedgerDirection.Debit],
      ] as const) {
        const transaction = bet(wallet.id, wallet.playerId, amount);
        await repositories.transactions.tryInsert(transaction);

        const movement = {
          entryId: randomUUID(),
          transactionId: transaction.id,
          money: brl(amount),
          now: LATER,
        };
        await repositories.ledger.append(
          direction === LedgerDirection.Debit
            ? locked.debit(movement)
            : locked.credit(movement),
        );
      }
      await repositories.wallets.save(locked);

      return {
        totais: await repositories.ledger.totalsByWallet(wallet.id, 'BRL'),
        noDominio: rebuildBalance(
          await repositories.ledger.listByWallet(wallet.id),
          'BRL',
        ),
        saldo: locked.balance,
      };
    });

    expect(totais.balance.toString()).toBe('75.00');
    expect(noDominio.toString()).toBe('75.00');
    expect(saldo.toString()).toBe('75.00');
    expect(totais.balance.equals(noDominio)).toBe(true);
    expect(totais.balance.equals(saldo)).toBe(true);
    // Abertura mais três movimentos, contados na mesma consulta da soma.
    expect(totais.entries).toBe(4);
  });

  it('devolve zero para wallet sem lançamento', async () => {
    const totais = await uow.run(async (repositories) => {
      const wallet = await openEmptyWallet(repositories);
      return repositories.ledger.totalsByWallet(wallet.id, 'BRL');
    });

    expect(totais.balance.toString()).toBe('0.00');
    expect(totais.entries).toBe(0);
  });

  it('encontra o lançamento pela transação', async () => {
    const { found, ausente } = await uow.run(async (repositories) => {
      const { wallet, openingTransaction } = await openWallet(
        repositories,
        '42.00',
      );

      return {
        found: await repositories.ledger.findByWalletAndTransaction(
          wallet.id,
          openingTransaction.id,
        ),
        ausente: await repositories.ledger.findByWalletAndTransaction(
          wallet.id,
          randomUUID(),
        ),
      };
    });

    expect(found?.money.toString()).toBe('42.00');
    expect(ausente).toBeUndefined();
  });
});

describe('inbox', () => {
  it('registra o consumo e deduplica na segunda vez', async () => {
    const messageId = randomUUID();

    const { first, second, found } = await uow.run(async (repositories) => {
      const message = InboxMessage.receive({
        messageId,
        consumerName: 'wager-transactions-consumer',
        payloadHash: hash(),
        receivedAt: NOW,
      });

      const firstOutcome = await repositories.inbox.tryInsert(message);
      const secondOutcome = await repositories.inbox.tryInsert(message);

      return {
        first: firstOutcome,
        second: secondOutcome,
        found: await repositories.inbox.find(
          'wager-transactions-consumer',
          messageId,
        ),
      };
    });

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(found?.isProcessed()).toBe(false);
  });

  it('persiste a marcação de processada', async () => {
    const reread = await uow.run(async (repositories) => {
      const messageId = randomUUID();
      const message = InboxMessage.receive({
        messageId,
        consumerName: 'wager-transactions-consumer',
        payloadHash: hash(),
        receivedAt: NOW,
      });
      await repositories.inbox.tryInsert(message);

      message.markProcessed(LATER);
      await repositories.inbox.save(message);

      return repositories.inbox.find('wager-transactions-consumer', messageId);
    });

    expect(reread?.isProcessed()).toBe(true);
    expect(reread?.processedAt?.getTime()).toBe(LATER.getTime());
  });
});

describe('outbox', () => {
  function probe(): OutboxMessage {
    return OutboxMessage.enqueue(
      ProbeEvent.from({
        eventId: randomUUID(),
        aggregateId: randomUUID(),
        correlationId: randomUUID(),
        occurredAt: NOW,
        data: {
          walletId: randomUUID(),
          money: { amount: '25.00', currency: 'BRL' },
        },
      }),
    );
  }

  it('grava o envelope em jsonb e o devolve igual', async () => {
    const message = probe();

    const claimed = await uow.run(async (repositories) => {
      await repositories.outbox.enqueue(message);
      return repositories.outbox.claimDue(NOW, 10);
    });

    const found = claimed.find((item) => item.id === message.id);
    expect(found).toBeDefined();
    expect(found?.eventType).toBe('WalletBalanceChanged');
    expect(found?.attempts).toBe(0);
    expect(found?.isPending()).toBe(true);

    // O envelope gravado é o que seria publicado: chave com valor undefined
    // não vira `null` na coluna, ela simplesmente não existe.
    expect(found?.payload).not.toHaveProperty('causationId');
    expect(found?.payload).toEqual(
      JSON.parse(JSON.stringify(message.payload)) as Record<string, unknown>,
    );
  });

  it('o envelope gravado carrega dinheiro como string decimal', async () => {
    // Contrato de representação da outbox, verificado na coluna e não só no
    // objeto em memória.
    const message = probe();

    const payload = await uow.run(async (repositories) => {
      await repositories.outbox.enqueue(message);
      const claimed = await repositories.outbox.claimDue(NOW, 10);
      return claimed.find((item) => item.id === message.id)?.payload;
    });

    const data = (payload as { data?: ProbeData } | undefined)?.data;
    expect(data?.money.amount).toBe('25.00');
    expect(data?.money.currency).toBe('BRL');
    expect(typeof data?.money.amount).toBe('string');
  });

  it('sai da fila ao ser publicado', async () => {
    const message = probe();

    const claimed = await uow.run(async (repositories) => {
      await repositories.outbox.enqueue(message);
      message.markPublished(LATER);
      await repositories.outbox.save(message);

      return repositories.outbox.claimDue(LATER, 10);
    });

    expect(claimed.map((item) => item.id)).not.toContain(message.id);
  });

  it('volta para a fila com backoff, e só depois de vencer', async () => {
    const message = probe();

    const { antes, depois } = await uow.run(async (repositories) => {
      await repositories.outbox.enqueue(message);
      message.scheduleRetry(NOW);
      await repositories.outbox.save(message);

      return {
        antes: await repositories.outbox.claimDue(NOW, 10),
        depois: await repositories.outbox.claimDue(
          new Date(NOW.getTime() + 1_000),
          10,
        ),
      };
    });

    expect(antes.map((item) => item.id)).not.toContain(message.id);
    expect(depois.map((item) => item.id)).toContain(message.id);

    const reread = depois.find((item) => item.id === message.id);
    expect(reread?.attempts).toBe(1);
    expect(reread?.nextAttemptAt?.getTime()).toBe(NOW.getTime() + 1_000);
  });

  it('publica depois de uma retentativa, sem recusa do schema', async () => {
    // `markPublished` não limpa `nextAttemptAt`, de propósito: é histórico da
    // retentativa, e a fila é definida por `published_at is null` sozinho.
    // Uma constraint que exigisse os dois coerentes recusaria exatamente este
    // caminho.
    const message = probe();

    const claimed = await uow.run(async (repositories) => {
      await repositories.outbox.enqueue(message);
      message.scheduleRetry(NOW);
      await repositories.outbox.save(message);

      message.markPublished(LATER);
      await repositories.outbox.save(message);

      return repositories.outbox.claimDue(
        new Date(LATER.getTime() + 60_000),
        10,
      );
    });

    expect(claimed.map((item) => item.id)).not.toContain(message.id);
  });
});
