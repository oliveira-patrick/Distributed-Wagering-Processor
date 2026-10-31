/*
  Referências fora de ordem contra PostgreSQL REAL — nenhum mock.

    bun run infra:up && bun run test:integration

  Reversão fora de ordem: `REFUND` ou `ROLLBACK`
  entregue antes da transação que ele reverte. O worker sobe de verdade pelo
  `onApplicationBootstrap`.

  A agenda real espera onze minutos pela segunda tentativa, o que nenhuma
  suíte pode aguardar. Em vez de encurtar a agenda — que é decisão
  documentada e testada à parte, em `test/unit/reference-retry.spec.ts` —, os
  cenários **antecipam o vencimento** com um `update` em
  `next_reference_attempt_at`. O que se verifica aqui é o comportamento do
  worker diante de uma transação vencida, não a aritmética da espera.

  Em todo teste que move saldo, a invariante é conferida:
  `wallet.balance` igual à soma com sinal do ledger.
*/
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { Money } from '../../src/domain/money/money';
import { createTestDatabase } from './support/test-database';
import type { TestDatabase } from './support/test-database';
import { createTestQueues } from './support/test-queues';
import type { TestQueues } from './support/test-queues';

const EFFECT_BUDGET_MS = 30_000;
const SETUP_BUDGET_MS = 120_000;

// `MAX_REFERENCE_ATTEMPTS` é 8, contando a submissão.
const ATTEMPTS_BEFORE_LAST = 7;

let db: TestDatabase | undefined;
let queues: TestQueues | undefined;
let app: INestApplication | undefined;

const previous: Record<string, string | undefined> = {};

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

async function waitFor<T>(
  what: string,
  probe: () => Promise<T | undefined>,
): Promise<T> {
  const deadline = Date.now() + EFFECT_BUDGET_MS;

  for (;;) {
    const found = await probe();
    if (found !== undefined) {
      return found;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `${what} não aconteceu em ${String(EFFECT_BUDGET_MS)} ms`,
      );
    }
    await Bun.sleep(100);
  }
}

interface Wallet {
  readonly id: string;
  readonly playerId: string;
}

async function createWallet(amount = '1000.00'): Promise<Wallet> {
  const { CreateWalletUseCase } =
    await import('../../src/application/use-cases/create-wallet.use-case');

  const useCase = application().get(CreateWalletUseCase, { strict: false });
  const playerId = randomUUID();
  const result = await useCase.execute(
    { playerId, initialBalance: Money.from({ amount, currency: 'BRL' }) },
    randomUUID(),
  );

  if (result.outcome !== 'created') {
    throw new Error(`não foi possível criar a wallet: ${result.detail}`);
  }

  return { id: result.wallet.id, playerId };
}

interface SubmitOptions {
  readonly wallet: Wallet;
  readonly kind: 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK';
  readonly amount?: string;
  readonly externalTransactionId?: string;
  readonly referenceExternalTransactionId?: string;
  readonly roundId?: string;
}

async function submit(options: SubmitOptions): Promise<{
  transactionId: string | undefined;
  status: string | undefined;
  failureCode: string | undefined;
}> {
  const { SubmitWagerTransactionUseCase } =
    await import('../../src/application/use-cases/submit-wager-transaction.use-case');

  const useCase = application().get(SubmitWagerTransactionUseCase, {
    strict: false,
  });

  const externalTransactionId = options.externalTransactionId ?? randomUUID();
  const result = await useCase.execute({
    idempotencyKey: `provider-a:${externalTransactionId}`,
    correlationId: randomUUID(),
    payload: {
      providerId: 'provider-a',
      externalTransactionId,
      playerId: options.wallet.playerId,
      walletId: options.wallet.id,
      roundId: options.roundId ?? 'round-987',
      gameId: 'fortune-chimp',
      kind: options.kind,
      money: Money.from({
        amount: options.amount ?? '25.00',
        currency: 'BRL',
      }),
      ...(options.referenceExternalTransactionId === undefined
        ? {}
        : {
            referenceExternalTransactionId:
              options.referenceExternalTransactionId,
          }),
    },
  });

  if (result.outcome === 'refused') {
    return {
      transactionId: undefined,
      status: undefined,
      failureCode: result.failureCode,
    };
  }

  return {
    transactionId: result.transaction.id,
    status: result.transaction.status,
    failureCode: result.transaction.failureCode,
  };
}

async function transactionRow(id: string): Promise<
  | {
      status: string;
      failure_code: string | null;
      reference_attempts: number;
      next_reference_attempt_at: Date | null;
      reference_transaction_id: string | null;
    }
  | undefined
> {
  const rows = await exec<
    {
      status: string;
      failure_code: string | null;
      reference_attempts: number;
      next_reference_attempt_at: Date | null;
      reference_transaction_id: string | null;
    }[]
  >(
    `select status, failure_code, reference_attempts,
            next_reference_attempt_at, reference_transaction_id
       from wager_transactions where id = ?`,
    [id],
  );
  return rows[0];
}

async function balanceOf(walletId: string): Promise<string | undefined> {
  const rows = await exec<{ amount: string }[]>(
    'select balance_amount::text as amount from wallets where id = ?',
    [walletId],
  );
  return rows[0]?.amount;
}

async function ledgerCountOf(walletId: string): Promise<number> {
  const rows = await exec<{ count: string }[]>(
    `select count(*)::text as count from wallet_ledger_entries
      where wallet_id = ?`,
    [walletId],
  );
  return Number(rows[0]?.count ?? '0');
}

async function outboxTypesOf(walletId: string): Promise<string[]> {
  const rows = await exec<{ event_type: string }[]>(
    `select event_type from outbox_messages
      where aggregate_id = ? order by occurred_at, id`,
    [walletId],
  );
  return rows.map((row) => row.event_type);
}

async function expectLedgerMatchesBalance(walletId: string): Promise<void> {
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
    [walletId],
  );

  expect(rows[0]?.stored).toBe(rows[0]?.rebuilt);
}

// Antecipa o vencimento da próxima tentativa. Ver o cabeçalho do arquivo.
async function makeDue(
  transactionId: string,
  attempts?: number,
): Promise<void> {
  if (attempts === undefined) {
    await exec(
      `update wager_transactions
          set next_reference_attempt_at = now()
        where id = ?`,
      [transactionId],
    );
    return;
  }

  await exec(
    `update wager_transactions
        set next_reference_attempt_at = now(), reference_attempts = ?
      where id = ?`,
    [attempts, transactionId],
  );
}

/*
  O id da transação submetida, ou falha dizendo por quê.

  Com `?? ''`, uma submissão recusada viraria `update ... where id = ''` e o
  teste falharia com erro de sintaxe de uuid, escondendo a recusa que é a
  causa real. Houve um caso assim nesta suíte.
*/
function transactionIdOf(result: {
  transactionId: string | undefined;
  failureCode: string | undefined;
}): string {
  if (result.transactionId === undefined) {
    throw new Error(
      `a submissão foi recusada com ${result.failureCode ?? 'motivo ausente'}`,
    );
  }
  return result.transactionId;
}

beforeAll(async () => {
  db = await createTestDatabase('reference');
  queues = await createTestQueues('reference');

  for (const name of [
    'POSTGRES_DB',
    'SQS_QUEUE_NAME',
    'SQS_DLQ_NAME',
    'SQS_EVENTS_QUEUE_NAME',
    'SQS_EVENTS_DLQ_NAME',
    'REFERENCE_POLL_INTERVAL_MS',
  ]) {
    previous[name] = process.env[name];
  }

  process.env.POSTGRES_DB = db.name;
  process.env.REFERENCE_POLL_INTERVAL_MS = '100';
  queues.applyToEnv();

  const [{ ConfigModule }, { PersistenceModule }, { WorkersModule }] =
    await Promise.all([
      import('../../src/config/config.module'),
      import('../../src/infrastructure/persistence/persistence.module'),
      import('../../src/interfaces/workers/workers.module'),
    ]);

  const moduleRef = await Test.createTestingModule({
    imports: [ConfigModule, PersistenceModule, WorkersModule],
  }).compile();

  app = moduleRef.createNestApplication();
  await app.init();
}, SETUP_BUDGET_MS);

afterAll(async () => {
  await app?.close();
  await queues?.destroy();
  await db?.close();

  for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) {
      Reflect.deleteProperty(process.env, name);
    } else {
      process.env[name] = value;
    }
  }
}, SETUP_BUDGET_MS);

describe('REFUND antes da BET', () => {
  it('é aceito como PENDING_REFERENCE, com a próxima tentativa agendada', async () => {
    const wallet = await createWallet('100.00');
    const betExternalId = randomUUID();

    const refund = await submit({
      wallet,
      kind: 'REFUND',
      amount: '30.00',
      referenceExternalTransactionId: betExternalId,
    });

    expect(refund.status).toBe('PENDING_REFERENCE');

    const row = await transactionRow(transactionIdOf(refund));
    // A submissão **é** a primeira tentativa, e é ela que agenda a segunda.
    expect(row?.reference_attempts).toBe(1);
    expect(row?.next_reference_attempt_at).not.toBeNull();

    // Aceita, não aplicada: saldo intacto e sem lançamento além da abertura.
    expect(await balanceOf(wallet.id)).toBe('100.00');
    expect(await ledgerCountOf(wallet.id)).toBe(1);
    await expectLedgerMatchesBalance(wallet.id);
  });

  it('publica WagerTransactionPendingReference', async () => {
    const wallet = await createWallet('100.00');

    await submit({
      wallet,
      kind: 'REFUND',
      amount: '30.00',
      referenceExternalTransactionId: randomUUID(),
    });

    expect(await outboxTypesOf(wallet.id)).toContain(
      'WagerTransactionPendingReference',
    );
  });

  it('o worker aplica o efeito quando a referência aparece', async () => {
    const wallet = await createWallet('100.00');
    const betExternalId = randomUUID();

    // A reversão chega primeiro, antes da transação que ela reverte.
    const refund = await submit({
      wallet,
      kind: 'REFUND',
      amount: '30.00',
      referenceExternalTransactionId: betExternalId,
    });
    expect(refund.status).toBe('PENDING_REFERENCE');

    // Agora a BET referenciada chega e é aplicada.
    const bet = await submit({
      wallet,
      kind: 'BET',
      amount: '30.00',
      externalTransactionId: betExternalId,
    });
    expect(bet.status).toBe('PROCESSED');
    expect(await balanceOf(wallet.id)).toBe('70.00');

    await makeDue(transactionIdOf(refund));

    // O worker em segundo plano é quem encontra e aplica — nada aqui o
    // chama à mão.
    await waitFor('o REFUND ser aplicado pelo worker', async () => {
      const row = await transactionRow(transactionIdOf(refund));
      return row?.status === 'PROCESSED' ? row : undefined;
    });

    const row = await transactionRow(transactionIdOf(refund));
    // O crédito voltou: 100 − 30 + 30.
    expect(await balanceOf(wallet.id)).toBe('100.00');
    // Abertura, débito da BET, crédito do REFUND.
    expect(await ledgerCountOf(wallet.id)).toBe(3);
    // A referência resolvida é guardada pelo id **interno**.
    expect(row?.reference_transaction_id).toBe(transactionIdOf(bet));
    await expectLedgerMatchesBalance(wallet.id);
  });

  it('continua esperando, e conta a tentativa, enquanto a referência não vem', async () => {
    const wallet = await createWallet('100.00');

    const refund = await submit({
      wallet,
      kind: 'REFUND',
      amount: '30.00',
      referenceExternalTransactionId: randomUUID(),
    });

    await makeDue(transactionIdOf(refund));

    // Uma passada do worker leva a contagem a 2 e reagenda para 22 minutos
    // à frente — então a espera abaixo estabiliza em 2 e não segue subindo.
    const row = await waitFor('a segunda tentativa ser contada', async () => {
      const found = await transactionRow(transactionIdOf(refund));
      return found?.reference_attempts === 2 ? found : undefined;
    });

    // Segue em PENDING_REFERENCE: esperar não é transição de estado.
    expect(row.status).toBe('PENDING_REFERENCE');
    expect(row.next_reference_attempt_at).not.toBeNull();
    expect(await balanceOf(wallet.id)).toBe('100.00');
  });
});

describe('esgotamento da agenda', () => {
  it('recusa com REFERENCE_NOT_FOUND na última tentativa', async () => {
    const wallet = await createWallet('100.00');

    const refund = await submit({
      wallet,
      kind: 'REFUND',
      amount: '30.00',
      referenceExternalTransactionId: randomUUID(),
    });

    // Sétima tentativa já consumida: a execução a seguir é a oitava e última.
    await makeDue(transactionIdOf(refund), ATTEMPTS_BEFORE_LAST);

    const row = await waitFor('a recusa definitiva', async () => {
      const found = await transactionRow(transactionIdOf(refund));
      return found?.status === 'REJECTED' ? found : undefined;
    });

    expect(row.failure_code).toBe('REFERENCE_NOT_FOUND');
    // Terminal: sem nova tentativa agendada.
    expect(row.next_reference_attempt_at).toBeNull();

    // Recusa não altera saldo nem gera lançamento.
    expect(await balanceOf(wallet.id)).toBe('100.00');
    expect(await ledgerCountOf(wallet.id)).toBe(1);
    await expectLedgerMatchesBalance(wallet.id);
  });

  it('publica WagerTransactionRejected ao esgotar', async () => {
    const wallet = await createWallet('100.00');

    const refund = await submit({
      wallet,
      kind: 'REFUND',
      amount: '30.00',
      referenceExternalTransactionId: randomUUID(),
    });

    await makeDue(transactionIdOf(refund), ATTEMPTS_BEFORE_LAST);

    // O evento correspondente precisa ser publicado.
    await waitFor('o evento de recusa na outbox', async () => {
      const types = await outboxTypesOf(wallet.id);
      return types.includes('WagerTransactionRejected') ? types : undefined;
    });
  });

  it('o schema impede devolver uma transação terminal à agenda', async () => {
    const wallet = await createWallet('100.00');

    const refund = await submit({
      wallet,
      kind: 'REFUND',
      amount: '30.00',
      referenceExternalTransactionId: randomUUID(),
    });

    await makeDue(transactionIdOf(refund), ATTEMPTS_BEFORE_LAST);

    await waitFor('a recusa definitiva', async () => {
      const found = await transactionRow(transactionIdOf(refund));
      return found?.status === 'REJECTED' ? found : undefined;
    });

    /*
      A garantia não está no filtro da consulta do worker — está no schema.
      `wager_transactions_schedule_matches_status` recusa uma transação
      terminal com tentativa agendada, e por isso reagendar uma `REJECTED`
      não é algo que o worker precise se lembrar de evitar: é
      irrepresentável — a garantia mora no schema, não no worker.
    */
    let refusedBy = '';
    try {
      await exec(
        `update wager_transactions set next_reference_attempt_at = now()
          where id = ?`,
        [transactionIdOf(refund)],
      );
    } catch (error) {
      refusedBy =
        (error as { constraint?: string }).constraint ?? 'desconhecida';
    }

    expect(refusedBy).toBe('wager_transactions_schedule_matches_status');
  });
});

describe('ROLLBACK antes da referência', () => {
  it('espera, e depois inverte o efeito da transação referenciada', async () => {
    const wallet = await createWallet('100.00');
    const winExternalId = randomUUID();

    // `ROLLBACK` de um `WIN` é um débito: a direção é a inversa da
    // referência.
    const rollback = await submit({
      wallet,
      kind: 'ROLLBACK',
      amount: '40.00',
      referenceExternalTransactionId: winExternalId,
    });
    expect(rollback.status).toBe('PENDING_REFERENCE');

    const win = await submit({
      wallet,
      kind: 'WIN',
      amount: '40.00',
      externalTransactionId: winExternalId,
    });
    expect(win.status).toBe('PROCESSED');
    expect(await balanceOf(wallet.id)).toBe('140.00');

    await makeDue(transactionIdOf(rollback));

    await waitFor('o ROLLBACK ser aplicado', async () => {
      const row = await transactionRow(transactionIdOf(rollback));
      return row?.status === 'PROCESSED' ? row : undefined;
    });

    // 100 + 40 − 40.
    expect(await balanceOf(wallet.id)).toBe('100.00');
    expect(await ledgerCountOf(wallet.id)).toBe(3);
    await expectLedgerMatchesBalance(wallet.id);
  });
});
