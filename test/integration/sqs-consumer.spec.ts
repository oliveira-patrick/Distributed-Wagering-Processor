/*
  Consumidor da fila contra PostgreSQL e MiniStack REAIS — nenhum mock.

    bun run infra:up && bun run test:integration

  O processo de worker sobe de verdade: `ConfigModule`, `PersistenceModule` e
  `WorkersModule`, com o consumidor iniciado pelo próprio
  `onApplicationBootstrap` e encerrado pelo `onApplicationShutdown`. Nenhum
  repositório e nenhum cliente de fila é substituído.

  Banco e filas são descartáveis, com nome único por execução.

  Em todo teste que move saldo, a invariante global é conferida:
  `wallet.balance` igual à soma com sinal do ledger.
*/
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';

import { Money } from '../../src/domain/money/money';
import { createTestDatabase } from './support/test-database';
import type { TestDatabase } from './support/test-database';
import { createTestQueues } from './support/test-queues';
import type { TestQueues } from './support/test-queues';

const CONSUMER_NAME = 'consumer-spec';

// Curto de propósito: o teste de DLQ precisa esgotar as entregas rápido.
const VISIBILITY_TIMEOUT_SECONDS = 2;
const MAX_RECEIVE_COUNT = 3;

// Quanto se espera por um efeito que o consumidor produz em segundo plano.
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

/*
  Espera uma condição que o consumidor satisfaz de forma assíncrona.

  Laço com prazo, e não `sleep` de duração fixa: o `sleep` é
  simultaneamente lento no caminho feliz e frágil numa máquina carregada —
  os dois defeitos de uma vez. Aqui, quem passa termina na primeira
  verificação, e quem falha falha com diagnóstico.
*/
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

interface MessagePayload {
  readonly providerId?: string;
  readonly externalTransactionId?: string;
  readonly idempotencyKey?: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly roundId?: string;
  readonly gameId?: string;
  readonly kind: string;
  readonly money?: { amount: string; currency: string };
  readonly referenceExternalTransactionId?: string;
}

// Monta o envelope de `WagerTransactionRequested`.
function envelope(
  payload: MessagePayload,
  messageId = randomUUID(),
): Record<string, unknown> {
  const providerId = payload.providerId ?? 'provider-a';
  const externalTransactionId = payload.externalTransactionId ?? randomUUID();

  return {
    messageId,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: {
      providerId,
      externalTransactionId,
      idempotencyKey:
        payload.idempotencyKey ?? `${providerId}:${externalTransactionId}`,
      playerId: payload.playerId,
      walletId: payload.walletId,
      roundId: payload.roundId ?? 'round-987',
      gameId: payload.gameId ?? 'fortune-chimp',
      kind: payload.kind,
      money: payload.money ?? { amount: '25.00', currency: 'BRL' },
      ...(payload.referenceExternalTransactionId === undefined
        ? {}
        : {
            referenceExternalTransactionId:
              payload.referenceExternalTransactionId,
          }),
    },
  };
}

/*
  Publica na fila de entrada.

  O `MessageDeduplicationId` é próprio de cada publicação, e não derivado do
  `messageId`. É isso que permite publicar **a mesma mensagem duas vezes** e
  ver as duas serem entregues — sem isso, a deduplicação do broker absorveria
  a segunda e o teste de redelivery não testaria o inbox, que é a garantia
  persistente, que é a única que sobrevive a uma queda do processo.
*/
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

async function publishRaw(body: string, groupId: string): Promise<void> {
  await sqs().client.send(
    new SendMessageCommand({
      QueueUrl: sqs().input.url,
      MessageBody: body,
      MessageGroupId: groupId,
      MessageDeduplicationId: randomUUID(),
    }),
  );
}

async function createWallet(amount = '1000.00'): Promise<{
  id: string;
  playerId: string;
}> {
  const { CreateWalletUseCase } =
    await import('../../src/application/use-cases/create-wallet.use-case');

  if (app === undefined) {
    throw new Error('a aplicação não subiu; veja a falha do beforeAll');
  }

  const useCase = app.get(CreateWalletUseCase, { strict: false });
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

async function balanceOf(walletId: string): Promise<string | undefined> {
  const rows = await exec<{ amount: string }[]>(
    'select balance_amount::text as amount from wallets where id = ?',
    [walletId],
  );
  return rows[0]?.amount;
}

// Saldo igual à soma com sinal do ledger, conferido em SQL.
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

async function ledgerCountOf(walletId: string): Promise<number> {
  const rows = await exec<{ count: string }[]>(
    'select count(*)::text as count from wallet_ledger_entries where wallet_id = ?',
    [walletId],
  );
  return Number(rows[0]?.count ?? '0');
}

async function inboxRowsOf(
  messageId: string,
): Promise<{ consumer_name: string; processed_at: Date | null }[]> {
  return exec<{ consumer_name: string; processed_at: Date | null }[]>(
    `select consumer_name, processed_at
       from inbox_messages
      where message_id = ?`,
    [messageId],
  );
}

async function outboxTypesOf(walletId: string): Promise<string[]> {
  const rows = await exec<{ event_type: string }[]>(
    `select event_type from outbox_messages
      where aggregate_id = ? order by occurred_at, id`,
    [walletId],
  );
  return rows.map((row) => row.event_type);
}

// Quantas mensagens visíveis a fila tem, pelo atributo do broker.
async function visibleCount(queueUrl: string): Promise<number> {
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

async function receiveFromDeadLetter(): Promise<string | undefined> {
  const result = await sqs().client.send(
    new ReceiveMessageCommand({
      QueueUrl: sqs().input.deadLetterUrl,
      MaxNumberOfMessages: 1,
      WaitTimeSeconds: 1,
    }),
  );
  return result.Messages?.[0]?.Body;
}

beforeAll(async () => {
  db = await createTestDatabase('consumer');
  queues = await createTestQueues('consumer', {
    visibilityTimeoutSeconds: VISIBILITY_TIMEOUT_SECONDS,
    maxReceiveCount: MAX_RECEIVE_COUNT,
  });

  for (const name of [
    'POSTGRES_DB',
    'SQS_QUEUE_NAME',
    'SQS_DLQ_NAME',
    'SQS_EVENTS_QUEUE_NAME',
    'SQS_EVENTS_DLQ_NAME',
    'SQS_CONSUMER_NAME',
  ]) {
    previous[name] = process.env[name];
  }

  process.env.POSTGRES_DB = db.name;
  process.env.SQS_CONSUMER_NAME = CONSUMER_NAME;
  queues.applyToEnv();

  /*
    Import dinâmico, pela mesma razão do `api.spec.ts`: o
    `NestConfigModule.forRoot` roda na avaliação do decorator, isto é, no
    instante do import. Com import estático no topo, o consumidor subiria
    apontado para o banco e para as filas de desenvolvimento.
  */
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

  // `init` dispara `onApplicationBootstrap`, que é quem inicia o consumidor.
  await app.init();
}, SETUP_BUDGET_MS);

afterAll(async () => {
  /*
    `close` dispara `onApplicationShutdown`: é o encerramento gracioso da
    da aplicação sendo exercitado em toda execução desta suíte, não só no teste que fala dele.
  */
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

describe('consumo de WagerTransactionRequested', () => {
  it('aplica o efeito financeiro e confirma a mensagem', async () => {
    const wallet = await createWallet('1000.00');
    const messageId = randomUUID();

    await publish(
      envelope(
        { playerId: wallet.playerId, walletId: wallet.id, kind: 'BET' },
        messageId,
      ),
      wallet.id,
    );

    await waitFor('o débito da aposta', async () =>
      (await balanceOf(wallet.id)) === '975.00' ? true : undefined,
    );

    expect(await ledgerCountOf(wallet.id)).toBe(2); // OPENING + BET
    await expectLedgerMatchesBalance(wallet.id);

    /*
      A mensagem saiu da fila — e saiu **depois** do commit, porque o efeito
      acima já estava no banco quando esta conferência passou.
    */
    await waitFor('a fila esvaziar', async () =>
      (await visibleCount(sqs().input.url)) === 0 ? true : undefined,
    );
  });

  it('grava o inbox na mesma transação, já marcado como processado', async () => {
    const wallet = await createWallet('500.00');
    const messageId = randomUUID();

    await publish(
      envelope(
        { playerId: wallet.playerId, walletId: wallet.id, kind: 'BET' },
        messageId,
      ),
      wallet.id,
    );

    const rows = await waitFor('o registro de inbox', async () => {
      const found = await inboxRowsOf(messageId);
      return found.length > 0 ? found : undefined;
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.consumer_name).toBe(CONSUMER_NAME);
    /*
      Marcado no mesmo commit do efeito: nunca existe linha de inbox sem
      `processed_at` depois de a transação confirmar.
    */
    expect(rows[0]?.processed_at).not.toBeNull();
  });

  it('publica os eventos de integração na outbox, no mesmo commit', async () => {
    const wallet = await createWallet('300.00');

    await publish(
      envelope(
        { playerId: wallet.playerId, walletId: wallet.id, kind: 'BET' },
        randomUUID(),
      ),
      wallet.id,
    );

    const types = await waitFor('os eventos na outbox', async () => {
      const found = await outboxTypesOf(wallet.id);
      // Dois da abertura, dois da aposta.
      return found.length >= 4 ? found : undefined;
    });

    expect(types).toContain('WagerTransactionProcessed');
    expect(types).toContain('WalletBalanceChanged');
  });

  it('a mesma mensagem entregue duas vezes produz um único débito', async () => {
    const wallet = await createWallet('100.00');
    const messageId = randomUUID();
    const message = envelope(
      {
        playerId: wallet.playerId,
        walletId: wallet.id,
        kind: 'BET',
        money: { amount: '30.00', currency: 'BRL' },
      },
      messageId,
    );

    /*
      Duas publicações do **mesmo** envelope, com ids de deduplicação
      diferentes: o broker entrega as duas, e quem recusa a segunda é o
      inbox persistente. É o caso de redelivery do broker.
    */
    await publish(message, wallet.id);
    await publish(message, wallet.id);

    await waitFor('o débito único', async () =>
      (await balanceOf(wallet.id)) === '70.00' ? true : undefined,
    );

    await waitFor('as duas entregas serem consumidas', async () =>
      (await visibleCount(sqs().input.url)) === 0 ? true : undefined,
    );

    /*
      Um lançamento da abertura e um da aposta. Se a deduplicação tivesse
      falhado, haveria três — e o saldo seria 40,00.
    */

    expect(await ledgerCountOf(wallet.id)).toBe(2);
    expect(await balanceOf(wallet.id)).toBe('70.00');
    expect(await inboxRowsOf(messageId)).toHaveLength(1);
    await expectLedgerMatchesBalance(wallet.id);
  });

  it('recusa por regra de negócio é terminal: confirma e não move saldo', async () => {
    const wallet = await createWallet('10.00');

    await publish(
      envelope(
        {
          playerId: wallet.playerId,
          walletId: wallet.id,
          kind: 'BET',
          money: { amount: '999.00', currency: 'BRL' },
        },
        randomUUID(),
      ),
      wallet.id,
    );

    const status = await waitFor('a transação rejeitada', async () => {
      const rows = await exec<{ status: string; failure_code: string }[]>(
        `select status, failure_code from wager_transactions
          where wallet_id = ? and kind = 'BET'`,
        [wallet.id],
      );
      return rows[0];
    });

    expect(status.status).toBe('REJECTED');
    expect(status.failure_code).toBe('INSUFFICIENT_FUNDS');
    expect(await balanceOf(wallet.id)).toBe('10.00');
    // Recusa não gera lançamento. Só sobra o da abertura.
    expect(await ledgerCountOf(wallet.id)).toBe(1);
    await expectLedgerMatchesBalance(wallet.id);

    // Terminal: recebe `ack` e não volta pela fila.
    await waitFor('a fila esvaziar', async () =>
      (await visibleCount(sqs().input.url)) === 0 ? true : undefined,
    );
  });
});

describe('classificação de erro', () => {
  it('JSON inválido vai direto à DLQ, sem gastar as entregas', async () => {
    await publishRaw('{ isto não é json', 'malformed');

    const body = await waitFor('a mensagem na DLQ', async () =>
      receiveFromDeadLetter(),
    );

    expect(body).toContain('isto não é json');

    /*
      Sem gastar as entregas" é o ponto: erro permanente não melhora na
      reentrega, então ele não fica dando voltas até o `maxReceiveCount`.
    */
    await waitFor('a fila de entrada esvaziar', async () =>
      (await visibleCount(sqs().input.url)) === 0 ? true : undefined,
    );
  });

  it('OPENING pela fila é recusado pelo contrato de entrada', async () => {
    const wallet = await createWallet('50.00');

    /*
      `OPENING` é interno: não pode ser submetido pela
      API nem pela fila. Quem recusa é o contrato, não o agregado.
    */
    await publish(
      envelope(
        { playerId: wallet.playerId, walletId: wallet.id, kind: 'OPENING' },
        randomUUID(),
      ),
      wallet.id,
    );

    const body = await waitFor('a recusa na DLQ', async () =>
      receiveFromDeadLetter(),
    );

    expect(body).toContain('OPENING');
    expect(await balanceOf(wallet.id)).toBe('50.00');
    expect(await ledgerCountOf(wallet.id)).toBe(1);
  });

  it('tipo de mensagem desconhecido é permanente', async () => {
    const wallet = await createWallet('50.00');
    const message = envelope(
      { playerId: wallet.playerId, walletId: wallet.id, kind: 'BET' },
      randomUUID(),
    );
    message.type = 'AlgoQueNaoConhecemos';

    await publishRaw(JSON.stringify(message), wallet.id);

    const body = await waitFor('a recusa na DLQ', async () =>
      receiveFromDeadLetter(),
    );

    expect(body).toContain('AlgoQueNaoConhecemos');
    expect(await ledgerCountOf(wallet.id)).toBe(1);
  });
});
