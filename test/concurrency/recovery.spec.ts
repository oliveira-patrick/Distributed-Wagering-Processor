/*
  Recuperação de falha, com processos de verdade.

    bun run infra:up && bun run test:concurrency

  Quatro situações: worker morto entre o commit e o `ack`, dois publicadores
  sobre a mesma outbox, reversão entregue antes da referência, e reinício do
  serviço com a consistência final comprovada.

  A primeira é construída de forma **determinística**, e vale explicar como,
  porque matar um processo "no instante entre o commit e o `ack`" não é algo
  que se consiga por cronometragem:

   1. a mensagem é publicada na fila;
   2. o teste a **recebe** com o cliente do SDK — ela fica em voo, invisível
      para os outros consumidores — e a processa chamando o caso de uso de
      consumo em processo, que comita;
   3. o teste **não** apaga a mensagem. Esse é exatamente o estado que um
      worker morto entre o commit e o `ack` deixa para trás;
   4. o `VisibilityTimeout` expira e a mensagem reaparece;
   5. um worker de verdade sobe, a recebe e precisa **não** duplicar nada.

  Nada aí é mock: PostgreSQL, SQS e o caso de uso são os de produção. O que
  se substitui é só quem deixou de chamar `DeleteMessage` — e é essa ausência
  que este teste existe para reproduzir.
*/
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';

import { createTestDatabase } from '../integration/support/test-database';
import type { TestDatabase } from '../integration/support/test-database';
import { createTestQueues } from '../integration/support/test-queues';
import type { TestQueues } from '../integration/support/test-queues';
import { spawnInstance, terminateAll } from './support/instances';
import type { SpawnedInstance } from './support/instances';

const VISIBILITY_TIMEOUT_SECONDS = 2;
const SETUP_BUDGET_MS = 180_000;
const EFFECT_BUDGET_MS = 60_000;

let db: TestDatabase | undefined;
let queues: TestQueues | undefined;
// Aplicação em processo, **sem** workers: só para usar os casos de uso.
let app: INestApplication | undefined;
const spawned: SpawnedInstance[] = [];

const previous: Record<string, string | undefined> = {};

function sqs(): TestQueues {
  if (queues === undefined) {
    throw new Error('as filas não subiram; veja a falha do beforeAll');
  }
  return queues;
}

function application(): INestApplication {
  if (app === undefined) {
    throw new Error('a aplicação não subiu; veja a falha do beforeAll');
  }
  return app;
}

function database(): TestDatabase {
  if (db === undefined) {
    throw new Error('o banco não subiu; veja a falha do beforeAll');
  }
  return db;
}

async function exec<T>(
  sql: string,
  params: readonly unknown[] = [],
): Promise<T> {
  const rows: unknown = await database()
    .orm.em.getConnection()
    .execute(sql, [...params]);
  return rows as T;
}

async function waitFor<T>(
  what: string,
  probe: () => Promise<T | undefined>,
  budgetMs = EFFECT_BUDGET_MS,
): Promise<T> {
  const deadline = Date.now() + budgetMs;

  for (;;) {
    const found = await probe();
    if (found !== undefined) {
      return found;
    }
    if (Date.now() >= deadline) {
      throw new Error(`${what} não aconteceu em ${String(budgetMs)} ms`);
    }
    await Bun.sleep(100);
  }
}

async function startWorker(
  env?: Readonly<Record<string, string>>,
): Promise<SpawnedInstance> {
  const instance = await spawnInstance({
    role: 'worker',
    databaseName: database().name,
    queues: sqs(),
    ...(env === undefined ? {} : { env }),
  });
  spawned.push(instance);
  return instance;
}

interface Wallet {
  readonly id: string;
  readonly playerId: string;
}

async function createWallet(amount: string): Promise<Wallet> {
  const { CreateWalletUseCase } =
    await import('../../src/application/use-cases/create-wallet.use-case');
  const { Money } = await import('../../src/domain/money/money');

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

function envelope(
  wallet: Wallet,
  amount: string,
  overrides: {
    readonly messageId?: string;
    readonly kind?: string;
    readonly externalTransactionId?: string;
    readonly referenceExternalTransactionId?: string;
    readonly roundId?: string;
  } = {},
): Record<string, unknown> {
  const externalTransactionId = overrides.externalTransactionId ?? randomUUID();

  return {
    messageId: overrides.messageId ?? randomUUID(),
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: {
      providerId: 'provider-a',
      externalTransactionId,
      idempotencyKey: `provider-a:${externalTransactionId}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: overrides.roundId ?? 'round-987',
      gameId: 'fortune-chimp',
      kind: overrides.kind ?? 'BET',
      money: { amount, currency: 'BRL' },
      ...(overrides.referenceExternalTransactionId === undefined
        ? {}
        : {
            referenceExternalTransactionId:
              overrides.referenceExternalTransactionId,
          }),
    },
  };
}

async function publish(
  body: Record<string, unknown>,
  groupId: string,
): Promise<void> {
  await sqs().client.send(
    new SendMessageCommand({
      QueueUrl: sqs().input.url,
      MessageBody: JSON.stringify(body),
      MessageGroupId: groupId,
      MessageDeduplicationId: randomUUID(),
    }),
  );
}

async function balanceOf(walletId: string): Promise<string> {
  const rows = await exec<{ amount: string }[]>(
    'select balance_amount::text as amount from wallets where id = ?',
    [walletId],
  );
  const amount = rows[0]?.amount;
  if (amount === undefined) {
    throw new Error(`wallet ${walletId} não existe`);
  }
  return amount;
}

async function ledgerCountOf(walletId: string): Promise<number> {
  const rows = await exec<{ count: string }[]>(
    `select count(*)::text as count from wallet_ledger_entries
      where wallet_id = ?`,
    [walletId],
  );
  return Number(rows[0]?.count ?? '0');
}

async function inboxCountOf(messageId: string): Promise<number> {
  const rows = await exec<{ count: string }[]>(
    'select count(*)::text as count from inbox_messages where message_id = ?',
    [messageId],
  );
  return Number(rows[0]?.count ?? '0');
}

async function queueDepth(queueUrl: string): Promise<number> {
  const result = await sqs().client.send(
    new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: [
        'ApproximateNumberOfMessages',
        'ApproximateNumberOfMessagesNotVisible',
      ],
    }),
  );
  return (
    Number(result.Attributes?.ApproximateNumberOfMessages ?? '0') +
    Number(result.Attributes?.ApproximateNumberOfMessagesNotVisible ?? '0')
  );
}

// Saldo igual à soma com sinal do ledger.
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

beforeAll(async () => {
  db = await createTestDatabase('recovery');
  queues = await createTestQueues('recovery', {
    visibilityTimeoutSeconds: VISIBILITY_TIMEOUT_SECONDS,
    maxReceiveCount: 5,
  });

  for (const name of [
    'POSTGRES_DB',
    'SQS_QUEUE_NAME',
    'SQS_DLQ_NAME',
    'SQS_EVENTS_QUEUE_NAME',
    'SQS_EVENTS_DLQ_NAME',
  ]) {
    previous[name] = process.env[name];
  }

  process.env.POSTGRES_DB = db.name;
  queues.applyToEnv();

  /*
    `UseCasesModule`, e **não** `WorkersModule`: esta aplicação em processo
    existe só para o teste poder chamar os casos de uso. Com o módulo de
    workers, um consumidor subiria aqui dentro e disputaria as mensagens com
    os processos filhos — que é precisamente o que estes testes medem.
  */
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

/*
  Cada teste começa sem worker nenhum de pé.

  Sem isto, os workers de um teste sobrevivem para o seguinte — e como todo
  worker traz o seu publicador de outbox, o teste dos dois publicadores
  passava a ter quatro em vez de dois, com os dois novos encontrando a fila
  já drenada pelos antigos. Falhava de forma intermitente, e a causa não
  estava em lugar nenhum perto da asserção.
*/
afterEach(async () => {
  await terminateAll(spawned);
  spawned.length = 0;
});

afterAll(async () => {
  await terminateAll(spawned);
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

describe('morte entre o commit e o ack', () => {
  it('a reentrega não duplica o efeito', async () => {
    const wallet = await createWallet('100.00');
    const messageId = randomUUID();
    const body = envelope(wallet, '30.00', { messageId });

    await publish(body, wallet.id);

    // 1. Recebe a mensagem: ela fica em voo, invisível para os outros.
    const received = await waitFor('a mensagem ser recebida', async () => {
      const result = await sqs().client.send(
        new ReceiveMessageCommand({
          QueueUrl: sqs().input.url,
          MaxNumberOfMessages: 1,
          WaitTimeSeconds: 1,
        }),
      );
      return result.Messages?.[0];
    });

    expect(received.Body).toBeDefined();

    // 2. Processa e comita, pelo caso de uso de produção.
    const { wagerMessageSchema } =
      await import('../../src/application/contracts/wager-message.schema');
    const { ConsumeWagerMessageUseCase } =
      await import('../../src/application/use-cases/consume-wager-message.use-case');

    const parsed = wagerMessageSchema.parse(JSON.parse(received.Body ?? '{}'));
    const result = await application()
      .get(ConsumeWagerMessageUseCase, { strict: false })
      .execute(parsed);

    expect(result.outcome).toBe('processed');

    // O commit aconteceu: o efeito está no banco.
    expect(await balanceOf(wallet.id)).toBe('70.00');
    expect(await inboxCountOf(messageId)).toBe(1);

    // 3. E aqui o processo "morre": nenhum `DeleteMessage` é enviado.

    // 4. O VisibilityTimeout expira e a mensagem volta a ficar visível.
    await Bun.sleep((VISIBILITY_TIMEOUT_SECONDS + 1) * 1_000);
    expect(await queueDepth(sqs().input.url)).toBeGreaterThan(0);

    // 5. Um worker de verdade assume e recebe a reentrega.
    await startWorker();

    await waitFor('a reentrega ser consumida e confirmada', async () =>
      (await queueDepth(sqs().input.url)) === 0 ? true : undefined,
    );

    // O ponto central: nada foi duplicado.
    expect(await balanceOf(wallet.id)).toBe('70.00');
    // Abertura e um débito. Três lançamentos significariam débito duplicado.
    expect(await ledgerCountOf(wallet.id)).toBe(2);
    expect(await inboxCountOf(messageId)).toBe(1);
    await expectLedgerMatchesBalance(wallet.id);
  });
});

describe('reinício do serviço', () => {
  it('o worker morto no meio do trabalho não perde nem duplica nada', async () => {
    const wallet = await createWallet('10000.00');
    const total = 40;

    const worker = await startWorker({ CONSUMER_MAX_MESSAGES: '2' });

    for (let index = 0; index < total; index += 1) {
      await publish(envelope(wallet, '10.00'), wallet.id);
    }

    /*
      Espera o trabalho começar de verdade antes de matar — matar antes de
      ele consumir a primeira mensagem não testaria recuperação nenhuma.
    */
    await waitFor('o worker começar a consumir', async () =>
      (await ledgerCountOf(wallet.id)) > 1 ? true : undefined,
    );

    /*
      `SIGKILL`: sem shutdown gracioso, sem devolver visibilidade, sem
      oportunidade de confirmar o que estava em voo.
    */
    worker.kill();

    // O serviço reinicia.
    await startWorker({ CONSUMER_MAX_MESSAGES: '2' });

    await waitFor(
      'todas as mensagens serem processadas depois do reinício',
      async () =>
        (await queueDepth(sqs().input.url)) === 0 ? true : undefined,
    );

    // Exatamente uma vez cada: 10000 − 40 × 10.
    expect(await balanceOf(wallet.id)).toBe('9600.00');
    // Abertura mais os 40 débitos.
    expect(await ledgerCountOf(wallet.id)).toBe(total + 1);

    const processed = await exec<{ count: string }[]>(
      `select count(*)::text as count from wager_transactions
        where wallet_id = ? and kind = 'BET' and status = 'PROCESSED'`,
      [wallet.id],
    );
    expect(Number(processed[0]?.count ?? '0')).toBe(total);

    await expectLedgerMatchesBalance(wallet.id);
  });
});

describe('dois publicadores sobre a mesma outbox', () => {
  it('os dois trabalham, e nada é perdido nem publicado em dobro', async () => {
    const wallet = await createWallet('100.00');
    const pending = 200;
    const batchSize = 5;

    /*
      Os eventos são inseridos **antes** de os workers subirem, e o lote é
      pequeno de propósito.

      A primeira versão deste teste gerava sessenta eventos com lote de
      vinte, e falhava de vez em quando: um publicador levava tudo antes de o
      outro acordar, e o `skip locked` fazia o segundo encontrar fila vazia —
      comportamento correto, asserção errada. Com duzentos eventos e lotes de
      cinco são quarenta rodadas a disputar, cada uma com uma transação e um
      `SendMessage` pelo caminho; um só processo não as atravessa todas antes
      do primeiro polling do outro.
    */
    const eventIds = Array.from({ length: pending }, () => randomUUID());

    for (const eventId of eventIds) {
      await exec(
        `insert into outbox_messages
           (id, aggregate_id, event_type, payload, occurred_at, attempts,
            next_attempt_at, published_at)
         values (?, ?, 'WagerTransactionProcessed', ?::jsonb, now(), 0,
                 null, null)`,
        [eventId, wallet.id, JSON.stringify({ eventId })],
      );
    }

    // Dois workers de verdade, cada um com o seu publicador de outbox.
    const [first, second] = await Promise.all([
      startWorker({
        OUTBOX_POLL_INTERVAL_MS: '50',
        OUTBOX_BATCH_SIZE: String(batchSize),
      }),
      startWorker({
        OUTBOX_POLL_INTERVAL_MS: '50',
        OUTBOX_BATCH_SIZE: String(batchSize),
      }),
    ]);

    await waitFor('a outbox secar', async () => {
      const rows = await exec<{ count: string }[]>(
        `select count(*)::text as count from outbox_messages
          where published_at is null`,
      );
      return rows[0]?.count === '0' ? true : undefined;
    });

    const rows = await exec<{ total: string; published: string }[]>(
      `select count(*)::text as total,
              count(published_at)::text as published
         from outbox_messages`,
    );

    // Nada perdido: toda linha pendente virou publicada.
    expect(rows[0]?.published).toBe(rows[0]?.total);
    expect(Number(rows[0]?.total ?? '0')).toBeGreaterThanOrEqual(pending);

    /*
      E os dois processos realmente publicaram. A prova está no `/metrics` de
      cada um: o registry é por processo, então um worker que não publicou
      nada responde zero. Sem esta conferência, o teste passaria com um só
      worker fazendo todo o trabalho — e não teria testado concorrência.
    */
    const publishedBy = await Promise.all(
      [first, second].map(async (instance) => {
        const response = await fetch(`${instance.baseUrl}/metrics`);
        const text = await response.text();
        const line = text
          .split('\n')
          .find((candidate) =>
            candidate.startsWith(
              'wagering_outbox_published_total{outcome="published"}',
            ),
          );
        return Number(line?.split(' ').at(-1) ?? '0');
      }),
    );

    expect(publishedBy.every((count) => count > 0)).toBe(true);
    await expectLedgerMatchesBalance(wallet.id);
  });
});

describe('reversão entregue antes da referência', () => {
  it('a wallet fecha a conta mesmo com REFUND e BET chegando juntos', async () => {
    const wallet = await createWallet('100.00');
    const betExternalId = randomUUID();

    await startWorker({ REFERENCE_POLL_INTERVAL_MS: '200' });

    /*
      As duas mensagens vão juntas, no mesmo grupo. Qual delas o consumidor
      vê primeiro não é afirmado — é justamente o que não se controla. O que
      se afirma é o estado final, e ele é o mesmo nas duas ordens: ou o
      REFUND espera a BET e é aplicado depois, ou chega depois dela e é
      aplicado na hora.
    */
    await Promise.all([
      publish(
        envelope(wallet, '30.00', {
          kind: 'REFUND',
          referenceExternalTransactionId: betExternalId,
        }),
        wallet.id,
      ),
      publish(
        envelope(wallet, '30.00', {
          externalTransactionId: betExternalId,
        }),
        wallet.id,
      ),
    ]);

    await waitFor('as duas mensagens serem consumidas', async () =>
      (await queueDepth(sqs().input.url)) === 0 ? true : undefined,
    );

    const settled = await waitFor(
      'o REFUND assentar num dos dois estados possíveis',
      async () => {
        const rows = await exec<{ id: string; status: string }[]>(
          `select id, status from wager_transactions
            where wallet_id = ? and kind = 'REFUND'`,
          [wallet.id],
        );
        const row = rows[0];
        return row?.status === 'PROCESSED' ||
          row?.status === 'PENDING_REFERENCE'
          ? row
          : undefined;
      },
    );

    /*
      Os dois estados são corretos, e qual deles acontece depende da ordem de
      entrega — que é precisamente o que este teste não controla.

      Se o REFUND chegou **depois** da BET, foi aplicado na hora. Se chegou
      **antes**, virou `PENDING_REFERENCE` com a próxima tentativa agendada
      para onze minutos à frente, que é a agenda do ADR-004. Nenhuma suíte
      espera onze minutos, então o vencimento é antecipado aqui — a mesma
      técnica de `test/integration/pending-reference.spec.ts`, e pela mesma
      razão: o que se verifica é o worker diante de uma transação vencida,
      não a aritmética da espera.
    */
    if (settled.status === 'PENDING_REFERENCE') {
      await exec(
        `update wager_transactions set next_reference_attempt_at = now()
          where id = ?`,
        [settled.id],
      );

      await waitFor('o worker aplicar o REFUND que esperava', async () => {
        const rows = await exec<{ status: string }[]>(
          'select status from wager_transactions where id = ?',
          [settled.id],
        );
        return rows[0]?.status === 'PROCESSED' ? true : undefined;
      });
    }

    // Em qualquer das duas ordens, o REFUND acaba aplicado — nunca perdido.
    const rows = await exec<{ status: string }[]>(
      `select status from wager_transactions
        where wallet_id = ? and kind = 'REFUND'`,
      [wallet.id],
    );
    expect(rows[0]?.status).toBe('PROCESSED');

    // 100 − 30 + 30.
    expect(await balanceOf(wallet.id)).toBe('100.00');
    // Abertura, débito da BET, crédito do REFUND.
    expect(await ledgerCountOf(wallet.id)).toBe(3);
    await expectLedgerMatchesBalance(wallet.id);
  });
});
