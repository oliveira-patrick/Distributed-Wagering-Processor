/*
  Atomicidade das quatro escritas, contra PostgreSQL REAL — nenhum mock.

    bun run infra:up && bun run test:integration

  A persistência da transação, a alteração
  de saldo, o lançamento no ledger, o registro de inbox e o evento de
  integração sejam **atômicos**: ou tudo é confirmado junto, ou nada é. A
  garantia que este arquivo verifica.

  Aqui a fronteira transacional é exercitada diretamente, com os repositórios
  de produção. A falha é provocada por uma exceção lançada **depois** das
  cinco escritas — é a forma de pôr todas elas em voo e então derrubar a
  transação — é o "o processo pode morrer
  antes ou depois do commit").
*/
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import type { UnitOfWork } from '../../src/application/ports/unit-of-work';
import { InboxMessage } from '../../src/domain/messaging/inbox-message';
import { OutboxMessage } from '../../src/domain/messaging/outbox-message';
import { WalletBalanceChanged } from '../../src/domain/messaging/events';
import { Money } from '../../src/domain/money/money';
import { WagerTransaction } from '../../src/domain/wagering/wager-transaction';
import { WagerTransactionKind } from '../../src/domain/wagering/wager-transaction-kind';
import { createTestDatabase } from './support/test-database';
import type { TestDatabase } from './support/test-database';

const SETUP_BUDGET_MS = 120_000;
const CONSUMER_NAME = 'atomicity-spec';

let db: TestDatabase | undefined;
let app: INestApplication | undefined;
let previousDatabase: string | undefined;

function application(): INestApplication {
  if (app === undefined) {
    throw new Error('a aplicação não subiu; veja a falha do beforeAll');
  }
  return app;
}

async function exec<T>(
  sql: string,
  params: readonly unknown[] = [],
): Promise<T> {
  if (db === undefined) {
    throw new Error('o banco de teste não subiu; veja a falha do beforeAll');
  }
  const rows: unknown = await db.orm.em
    .getConnection()
    .execute(sql, [...params]);
  return rows as T;
}

async function unitOfWork(): Promise<UnitOfWork> {
  /*
    O token é um valor e vem por import dinâmico, como nas outras suítes; o
    tipo é importado estaticamente no topo, porque `import type` é apagado na
    compilação e não avalia o módulo.
  */
  const { UNIT_OF_WORK } =
    await import('../../src/application/ports/unit-of-work');
  return application().get(UNIT_OF_WORK, { strict: false });
}

interface Wallet {
  readonly id: string;
  readonly playerId: string;
}

async function createWallet(amount: string): Promise<Wallet> {
  const { CreateWalletUseCase } =
    await import('../../src/application/use-cases/create-wallet.use-case');

  const playerId = randomUUID();
  const result = await application()
    .get(CreateWalletUseCase, { strict: false })
    .execute(
      { playerId, initialBalance: Money.from({ amount, currency: 'BRL' }) },
      randomUUID(),
    );

  if (result.outcome !== 'created') {
    throw new Error(`não foi possível criar a wallet: ${result.detail}`);
  }
  return { id: result.wallet.id, playerId };
}

interface Counts {
  readonly balance: string;
  readonly ledger: number;
  readonly transactions: number;
  readonly inbox: number;
  readonly outbox: number;
}

async function snapshot(walletId: string, messageId: string): Promise<Counts> {
  const [wallet, ledger, transactions, inbox, outbox] = await Promise.all([
    exec<{ amount: string }[]>(
      'select balance_amount::text as amount from wallets where id = ?',
      [walletId],
    ),
    exec<{ count: string }[]>(
      `select count(*)::text as count from wallet_ledger_entries
        where wallet_id = ?`,
      [walletId],
    ),
    exec<{ count: string }[]>(
      `select count(*)::text as count from wager_transactions
        where wallet_id = ? and kind <> 'OPENING'`,
      [walletId],
    ),
    exec<{ count: string }[]>(
      'select count(*)::text as count from inbox_messages where message_id = ?',
      [messageId],
    ),
    exec<{ count: string }[]>(
      `select count(*)::text as count from outbox_messages
        where aggregate_id = ?`,
      [walletId],
    ),
  ]);

  return {
    balance: wallet[0]?.amount ?? '(wallet ausente)',
    ledger: Number(ledger[0]?.count ?? '0'),
    transactions: Number(transactions[0]?.count ?? '0'),
    inbox: Number(inbox[0]?.count ?? '0'),
    outbox: Number(outbox[0]?.count ?? '0'),
  };
}

/*
  As cinco escritas que precisam ser atômicas, numa transação só.

  `fail` controla se a transação termina em commit ou em exceção — é a única
  diferença entre os dois cenários abaixo, e tê-la como parâmetro é o que
  garante que os dois exercitam exatamente o mesmo caminho de escrita.
*/
async function applyFiveWrites(
  wallet: Wallet,
  messageId: string,
  amount: string,
  fail: boolean,
): Promise<void> {
  const uow = await unitOfWork();
  const now = new Date();

  await uow.run(async (repositories) => {
    const loaded = await repositories.wallets.findByIdForUpdate(wallet.id);
    if (loaded === undefined) {
      throw new Error('a wallet desapareceu');
    }

    // 1. inbox
    const received = InboxMessage.receive({
      messageId,
      consumerName: CONSUMER_NAME,
      payloadHash: 'a'.repeat(64),
      receivedAt: now,
    });
    await repositories.inbox.tryInsert(received);

    // 2. transação
    const transaction = WagerTransaction.create({
      id: randomUUID(),
      providerId: 'provider-a',
      externalTransactionId: randomUUID(),
      idempotencyKey: `provider-a:${randomUUID()}`,
      payloadHash: 'b'.repeat(64),
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: 'round-atomicidade',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Bet,
      money: Money.from({ amount, currency: 'BRL' }),
      referenceExternalTransactionId: undefined,
      createdAt: now,
    });
    await repositories.transactions.tryInsert(transaction);

    // 3. saldo e 4. lançamento, que o agregado produz juntos
    const entry = loaded.debit({
      entryId: randomUUID(),
      transactionId: transaction.id,
      money: Money.from({ amount, currency: 'BRL' }),
      now,
    });
    await repositories.ledger.append(entry);
    await repositories.wallets.save(loaded);

    transaction.markProcessed(undefined, now, loaded.balance);
    await repositories.transactions.save(transaction);

    // 5. evento na outbox
    await repositories.outbox.enqueue(
      OutboxMessage.enqueue(
        WalletBalanceChanged.from(loaded, entry, {
          eventId: randomUUID(),
          correlationId: randomUUID(),
          causationId: transaction.id,
          occurredAt: now,
        }),
      ),
    );

    received.markProcessed(now);
    await repositories.inbox.save(received);

    if (fail) {
      /*
        A exceção vem **depois** das cinco escritas, de propósito: é o que põe
        todas em voo antes de a transação cair. Uma falha antes da última
        escrita provaria menos — sobraria a dúvida de se a última chegou a ser
        emitida.
      */
      throw new Error('falha deliberada depois das cinco escritas');
    }
  });
}

beforeAll(async () => {
  db = await createTestDatabase('atomicity');

  previousDatabase = process.env.POSTGRES_DB;
  process.env.POSTGRES_DB = db.name;

  const [{ ConfigModule }, { PersistenceModule }, { UseCasesModule }] =
    await Promise.all([
      import('../../src/config/config.module'),
      import('../../src/infrastructure/persistence/persistence.module'),
      import('../../src/infrastructure/composition/use-cases.module'),
    ]);

  const moduleRef = await Test.createTestingModule({
    imports: [ConfigModule, PersistenceModule, UseCasesModule],
  }).compile();

  app = moduleRef.createNestApplication();
  await app.init();
}, SETUP_BUDGET_MS);

afterAll(async () => {
  await app?.close();
  await db?.close();

  if (previousDatabase === undefined) {
    Reflect.deleteProperty(process.env, 'POSTGRES_DB');
  } else {
    process.env.POSTGRES_DB = previousDatabase;
  }
}, SETUP_BUDGET_MS);

describe('atomicidade das cinco escritas', () => {
  it('confirmam juntas', async () => {
    const wallet = await createWallet('100.00');
    const messageId = randomUUID();

    const before = await snapshot(wallet.id, messageId);
    await applyFiveWrites(wallet, messageId, '30.00', false);
    const after = await snapshot(wallet.id, messageId);

    expect(before.balance).toBe('100.00');
    expect(after.balance).toBe('70.00');
    expect(after.ledger).toBe(before.ledger + 1);
    expect(after.transactions).toBe(before.transactions + 1);
    expect(after.inbox).toBe(1);
    expect(after.outbox).toBe(before.outbox + 1);
  });

  it('revertem juntas, sem deixar resíduo em nenhuma das cinco', async () => {
    const wallet = await createWallet('100.00');
    const messageId = randomUUID();

    const before = await snapshot(wallet.id, messageId);

    let threw = false;
    try {
      await applyFiveWrites(wallet, messageId, '30.00', true);
    } catch {
      threw = true;
    }

    expect(threw).toBe(true);

    // Tudo igual a antes: saldo, ledger, transação, inbox e outbox.
    expect(await snapshot(wallet.id, messageId)).toEqual(before);
  });

  it('o inbox revertido deixa a mensagem apta a ser reprocessada', async () => {
    /*
      É esta a propriedade que torna o rollback **útil**, e não só limpo: se
      a linha de inbox sobrevivesse ao rollback do efeito, a reentrega seria
      descartada como duplicata e a operação financeira se perderia para
      sempre. Esse é o pior desfecho possível do desenho.
    */
    const wallet = await createWallet('100.00');
    const messageId = randomUUID();

    let threw = false;
    try {
      await applyFiveWrites(wallet, messageId, '30.00', true);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);

    // Nenhuma linha de inbox sobrou.
    const afterRollback = await snapshot(wallet.id, messageId);
    expect(afterRollback.inbox).toBe(0);

    // E a segunda tentativa — a reentrega — passa e aplica o efeito.
    await applyFiveWrites(wallet, messageId, '30.00', false);

    const afterRetry = await snapshot(wallet.id, messageId);
    expect(afterRetry.balance).toBe('70.00');
    expect(afterRetry.inbox).toBe(1);
    expect(afterRetry.ledger).toBe(2); // abertura e o débito
  });

  it('o saldo continua igual à soma do ledger depois do rollback', async () => {
    const wallet = await createWallet('250.00');
    const messageId = randomUUID();

    try {
      await applyFiveWrites(wallet, messageId, '40.00', true);
    } catch {
      // esperado
    }

    const rows = await exec<{ stored: string; rebuilt: string }[]>(
      `select
         w.balance_amount::text as stored,
         coalesce(
           sum(
             case when e.direction = 'CREDIT'
                  then e.money_amount
                  else -e.money_amount
             end
           ),
           0
         )::numeric(20,2)::text as rebuilt
       from wallets w
       left join wallet_ledger_entries e on e.wallet_id = w.id
       where w.id = ?
       group by w.balance_amount`,
      [wallet.id],
    );

    // A invariante vale inclusive depois de uma falha.
    expect(rows[0]?.stored).toBe(rows[0]?.rebuilt);
    expect(rows[0]?.stored).toBe('250.00');
  });
});
