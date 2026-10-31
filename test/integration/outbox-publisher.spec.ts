/*
  Publicador da outbox contra PostgreSQL e MiniStack REAIS — nenhum mock.

    bun run infra:up && bun run test:integration

  O worker sobe de verdade, iniciado pelo `onApplicationBootstrap`, e publica
  na fila de saída descartável desta suíte. O que se verifica é o contrato da
  contrato da outbox: evento gravado no commit é publicado depois, o
  agrupamento é a
  wallet, a deduplicação é o `eventId`, a linha **não** é apagada, e um
  evento que ficou pendente por morte do processo é publicado por quem vier
  depois.
*/
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ReceiveMessageCommand } from '@aws-sdk/client-sqs';
import type { Message } from '@aws-sdk/client-sqs';

import { Money } from '../../src/domain/money/money';
import { createTestDatabase } from './support/test-database';
import type { TestDatabase } from './support/test-database';
import { createTestQueues } from './support/test-queues';
import type { TestQueues } from './support/test-queues';

const EFFECT_BUDGET_MS = 30_000;
const SETUP_BUDGET_MS = 120_000;

let db: TestDatabase | undefined;
let queues: TestQueues | undefined;
let app: INestApplication | undefined;

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

// Drena o que já estiver na fila de eventos, acumulando entre chamadas.
async function drainEvents(): Promise<Message[]> {
  const collected: Message[] = [];

  for (;;) {
    const result = await sqs().client.send(
      new ReceiveMessageCommand({
        QueueUrl: sqs().events.url,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
        MessageSystemAttributeNames: [
          'MessageGroupId',
          'MessageDeduplicationId',
        ],
      }),
    );

    const batch = result.Messages ?? [];
    collected.push(...batch);

    if (batch.length === 0) {
      return collected;
    }
  }
}

async function createWallet(amount = '1000.00'): Promise<string> {
  const { CreateWalletUseCase } =
    await import('../../src/application/use-cases/create-wallet.use-case');

  const useCase = application().get(CreateWalletUseCase, { strict: false });
  const result = await useCase.execute(
    {
      playerId: randomUUID(),
      initialBalance: Money.from({ amount, currency: 'BRL' }),
    },
    randomUUID(),
  );

  if (result.outcome !== 'created') {
    throw new Error(`não foi possível criar a wallet: ${result.detail}`);
  }

  return result.wallet.id;
}

async function outboxRowsOf(walletId: string): Promise<
  {
    id: string;
    event_type: string;
    published_at: Date | null;
    attempts: number;
  }[]
> {
  return exec(
    `select id, event_type, published_at, attempts
       from outbox_messages
      where aggregate_id = ?
      order by occurred_at, id`,
    [walletId],
  );
}

beforeAll(async () => {
  db = await createTestDatabase('outbox');
  queues = await createTestQueues('outbox');

  for (const name of [
    'POSTGRES_DB',
    'SQS_QUEUE_NAME',
    'SQS_DLQ_NAME',
    'SQS_EVENTS_QUEUE_NAME',
    'SQS_EVENTS_DLQ_NAME',
    'OUTBOX_POLL_INTERVAL_MS',
  ]) {
    previous[name] = process.env[name];
  }

  process.env.POSTGRES_DB = db.name;
  // Curto para a suíte não esperar o intervalo de produção a cada cenário.
  process.env.OUTBOX_POLL_INTERVAL_MS = '100';
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

describe('publicação dos eventos pendentes', () => {
  it('publica o que foi gravado no commit e marca a linha', async () => {
    const walletId = await createWallet('1000.00');

    const rows = await waitFor(
      'os eventos da abertura publicados',
      async () => {
        const found = await outboxRowsOf(walletId);
        return found.length > 0 &&
          found.every((row) => row.published_at !== null)
          ? found
          : undefined;
      },
    );

    /*
      A abertura publica `WagerTransactionProcessed` e `WalletBalanceChanged`
      — o crédito de abertura é uma transação aplicada e é uma mudança de
      saldo, então os dois eventos saem.
    */
    expect(rows.map((row) => row.event_type).sort()).toEqual([
      'WagerTransactionProcessed',
      'WalletBalanceChanged',
    ]);

    // Nenhuma tentativa gasta: publicou de primeira.
    expect(rows.every((row) => row.attempts === 0)).toBe(true);
  });

  it('não apaga a linha publicada — a outbox continua auditável', async () => {
    const walletId = await createWallet('250.00');

    await waitFor('a publicação', async () => {
      const found = await outboxRowsOf(walletId);
      return found.length === 2 && found.every((r) => r.published_at !== null)
        ? found
        : undefined;
    });

    const rows = await outboxRowsOf(walletId);
    expect(rows).toHaveLength(2);
    /*
      `published_at` preenchido, linha presente. Apagar seria mais barato e
      destruiria a trilha de qual evento saiu e quando.
    */
    expect(rows.every((row) => row.published_at !== null)).toBe(true);
  });

  it('agrupa por wallet e deduplica por eventId', async () => {
    const walletId = await createWallet('500.00');

    await waitFor('a publicação', async () => {
      const found = await outboxRowsOf(walletId);
      return found.length === 2 && found.every((r) => r.published_at !== null)
        ? found
        : undefined;
    });

    const published = await waitFor(
      'as mensagens na fila de saída',
      async () => {
        const drained = await drainEvents();
        const mine = drained.filter(
          (message) => message.Attributes?.MessageGroupId === walletId,
        );
        return mine.length >= 2 ? mine : undefined;
      },
    );

    const rows = await outboxRowsOf(walletId);
    const eventIds = rows.map((row) => row.id).sort();

    /*
      `MessageGroupId` é a wallet: é ela a unidade de ordenação, e com o
      `eventId` no lugar cada evento viraria o próprio grupo.
    */
    expect(
      published.every(
        (message) => message.Attributes?.MessageGroupId === walletId,
      ),
    ).toBe(true);

    /*
      `MessageDeduplicationId` é o `eventId`: é o que torna inofensiva a
      republicação de um evento cujo `markPublished` não comitou.
    */
    const dedupIds = published
      .map((message) => message.Attributes?.MessageDeduplicationId ?? '')
      .sort();
    expect(dedupIds).toEqual(eventIds);
  });

  it('o corpo publicado é o envelope gravado na transação', async () => {
    const walletId = await createWallet('77.00');

    const rows = await waitFor('a publicação', async () => {
      const found = await outboxRowsOf(walletId);
      return found.length === 2 && found.every((r) => r.published_at !== null)
        ? found
        : undefined;
    });

    const messages = await waitFor('a mensagem na fila', async () => {
      const drained = await drainEvents();
      const mine = drained.filter(
        (message) => message.Attributes?.MessageGroupId === walletId,
      );
      return mine.length >= 2 ? mine : undefined;
    });

    const stored = await exec<{ payload: Record<string, unknown> }[]>(
      'select payload from outbox_messages where id = ?',
      [rows[0]?.id],
    );

    const bodies = messages.map(
      (message) => JSON.parse(message.Body ?? '{}') as Record<string, unknown>,
    );

    /*
      O que viaja é exatamente o envelope decidido dentro da transação, não
      algo remontado depois a partir de campos soltos.
    */
    expect(bodies.some((body) => body.eventId === rows[0]?.id)).toBe(true);
    expect(stored[0]?.payload.eventId).toBe(rows[0]?.id);
  });
});

describe('recuperação depois de morte entre commit e publicação', () => {
  it('publica o evento que outra instância deixou pendente', async () => {
    /*
      Passo a passo: o PostgreSQL confirmou o commit,
      o processo morreu antes de publicar, e outra instância assume. A linha
      inserida aqui em SQL cru **é** o estado que aquele processo deixou
      para trás.
    */
    const walletId = await createWallet('10.00');
    const eventId = randomUUID();

    await exec(
      `insert into outbox_messages
         (id, aggregate_id, event_type, payload, occurred_at, attempts,
          next_attempt_at, published_at)
       values (?, ?, ?, ?::jsonb, now(), 0, null, null)`,
      [
        eventId,
        walletId,
        'WalletBalanceChanged',
        JSON.stringify({
          eventId,
          eventType: 'WalletBalanceChanged',
          aggregateId: walletId,
          correlationId: randomUUID(),
          occurredAt: new Date().toISOString(),
          version: 1,
          data: { walletId },
        }),
      ],
    );

    const published = await waitFor(
      'o evento órfão ser publicado',
      async () => {
        const rows = await exec<{ published_at: Date | null }[]>(
          'select published_at from outbox_messages where id = ?',
          [eventId],
        );
        return rows[0]?.published_at !== null ? rows[0] : undefined;
      },
    );

    expect(published.published_at).not.toBeNull();
  });
});

describe('publicadores concorrentes', () => {
  it('dois publicadores sobre a mesma outbox não publicam o mesmo evento', async () => {
    const { PublishOutboxUseCase } =
      await import('../../src/application/use-cases/publish-outbox.use-case');

    // Vinte eventos órfãos, para haver o que disputar.
    const walletId = await createWallet('5.00');
    const eventIds = Array.from({ length: 20 }, () => randomUUID());

    for (const eventId of eventIds) {
      await exec(
        `insert into outbox_messages
           (id, aggregate_id, event_type, payload, occurred_at, attempts,
            next_attempt_at, published_at)
         values (?, ?, 'WagerTransactionProcessed', ?::jsonb, now(), 0,
                 null, null)`,
        [eventId, walletId, JSON.stringify({ eventId })],
      );
    }

    const useCase = application().get(PublishOutboxUseCase, {
      strict: false,
    });

    /*
      Duas passadas **em paralelo** sobre a mesma tabela. O `skip locked` é o
      que faz cada uma levar um lote disjunto; sem ele, a segunda esperaria
      na primeira linha pendente ou — pior, com `read committed` e sem lock —
      as duas publicariam o mesmo evento.
    */
    const [first, second] = await Promise.all([
      useCase.publishDue(),
      useCase.publishDue(),
    ]);

    /*
      A afirmação que importa: os dois conjuntos são **disjuntos**. Contagem
      sozinha passaria igual se as duas passadas tivessem publicado o mesmo
      evento, que é precisamente a falha que o `skip locked` evita.
    */

    const overlap = first.publishedIds.filter((id) =>
      second.publishedIds.includes(id),
    );
    expect(overlap).toEqual([]);

    // E nenhum evento foi publicado duas vezes no total.
    const union = new Set([...first.publishedIds, ...second.publishedIds]);
    expect(union.size).toBe(
      first.publishedIds.length + second.publishedIds.length,
    );

    // E o worker em segundo plano termina o resto.
    await waitFor('todos os eventos publicados', async () => {
      const pending = await exec<{ count: string }[]>(
        `select count(*)::text as count from outbox_messages
          where aggregate_id = ? and published_at is null`,
        [walletId],
      );
      return pending[0]?.count === '0' ? true : undefined;
    });
  });
});

describe('outbox lag', () => {
  it('é medido como gauge, e volta a zero quando a fila seca', async () => {
    const { PublishOutboxUseCase } =
      await import('../../src/application/use-cases/publish-outbox.use-case');
    const { METRICS_EXPOSITION } =
      await import('../../src/application/ports/metrics.port');

    await createWallet('1.00');

    const useCase = application().get(PublishOutboxUseCase, {
      strict: false,
    });

    await waitFor('a outbox secar', async () => {
      const pending = await exec<{ count: string }[]>(
        'select count(*)::text as count from outbox_messages where published_at is null',
      );
      return pending[0]?.count === '0' ? true : undefined;
    });

    await useCase.reportLag();

    const exposition = application().get<{ render(): string }>(
      METRICS_EXPOSITION,
      { strict: false },
    );
    const text = exposition.render();

    expect(text).toContain('wagering_outbox_pending_count 0');
    expect(text).toContain('wagering_outbox_pending_age_seconds 0');
  });
});
