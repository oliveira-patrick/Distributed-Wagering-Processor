/*
  Integração contra o emulador de SQS REAL — nenhum mock.

    bun run infra:up && bun run test:integration

  Valida as capacidades de que o desenho depende e que, no MiniStack, são
  declaradas pelo próprio projeto e não verificadas de forma independente:
  filas FIFO, deduplicação por MessageDeduplicationId e redrive para DLQ por
  maxReceiveCount. Se qualquer uma falhar, a escolha do emulador precisa ser
  revista (ver ADR-002).

  As filas são efêmeras e criadas por execução, com nomes únicos: o teste
  nunca toca as filas da aplicação.
*/
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ListQueuesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
} from '@aws-sdk/client-sqs';

import { createSqsClient } from '../../src/infrastructure/messaging/sqs.client';
import { describeError } from '../../src/shared/describe-error';

function env(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) throw new Error(`Variável ausente: ${name}`);
  return value;
}

// Curto de propósito: o teste de DLQ precisa esgotar as tentativas rápido.
const TEST_VISIBILITY_TIMEOUT = 1;
const TEST_MAX_RECEIVE_COUNT = 2;

const suffix = `${String(Date.now())}-${String(Math.floor(Math.random() * 10_000))}`;
const mainQueueName = `test-wager-${suffix}.fifo`;
const dlqName = `test-wager-dlq-${suffix}.fifo`;

// Quanto se espera pelo emulador antes de desistir.
const EMULATOR_BUDGET_MS = 60_000;
const EMULATOR_RETRY_DELAY_MS = 500;

/*
  Orçamento do hook, maior que o do emulador de propósito.

  Se o prazo do hook fosse o menor dos dois, o estouro apareceria como "a
  beforeEach/afterEach hook timed out" — sem dizer o que não respondeu nem o
  que fazer. Com o hook mais folgado, quem estoura primeiro é a espera do
  emulador, que falha com diagnóstico.
*/
const SETUP_BUDGET_MS = EMULATOR_BUDGET_MS + 30_000;

/*
  Criado no topo, e não dentro do `beforeAll`: o cliente do SDK é lazy, não
  abre conexão nenhuma na construção, e tê-lo sempre disponível garante que o
  `afterAll` consiga limpar mesmo que o setup falhe no meio.
*/
const client = createSqsClient({
  region: env('AWS_REGION'),
  accessKeyId: env('AWS_ACCESS_KEY_ID'),
  secretAccessKey: env('AWS_SECRET_ACCESS_KEY'),
  endpoint: env('SQS_ENDPOINT', ''),
  requestTimeoutMs: Number(env('SQS_REQUEST_TIMEOUT_MS', '30000')),
  connectionTimeoutMs: Number(env('SQS_CONNECTION_TIMEOUT_MS', '3000')),
});

/*
  Inicializadas vazias, e não só atribuídas no `beforeAll`: é o que o
  `afterAll` testa para saber o que existe para apagar, e um setup que falhe
  antes da atribuição deixaria `undefined` passando pelo teste de `!== ''`.
*/
let mainQueueUrl = '';
let dlqUrl = '';

async function receiveOne(
  queueUrl: string,
  waitSeconds = 1,
): Promise<{ body: string; receiptHandle: string } | undefined> {
  const result = await client.send(
    new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: 1,
      WaitTimeSeconds: waitSeconds,
    }),
  );
  const message = result.Messages?.[0];
  if (message?.Body === undefined || message.ReceiptHandle === undefined) {
    return undefined;
  }
  return { body: message.Body, receiptHandle: message.ReceiptHandle };
}

/*
  Espera o emulador responder antes de montar o cenário.

  Timeout é indisponibilidade, e a indisponibilidade de um container que
  acabou de subir é condição transitória — não é falha do que esta suíte quer
  provar. Sem a espera, um emulador frio reprovava FIFO, deduplicação e DLQ
  por um motivo que não tem relação com nenhum dos três.

  `ListQueues` é a sonda certa porque qualquer resposta, inclusive erro de
  negócio, prova que o serviço está atendendo. O que se espera aqui é o
  transporte, não um estado da fila.
*/
async function waitForEmulator(): Promise<void> {
  const deadline = Date.now() + EMULATOR_BUDGET_MS;
  let lastFailure: unknown;

  for (;;) {
    try {
      await client.send(new ListQueuesCommand({ MaxResults: 1 }));
      return;
    } catch (error) {
      lastFailure = error;
    }

    if (Date.now() + EMULATOR_RETRY_DELAY_MS >= deadline) {
      throw new Error(
        `SQS não respondeu em ${String(EMULATOR_BUDGET_MS)} ms. ` +
          'Suba a infraestrutura com "bun run infra:up" e confira com ' +
          '"bun run infra:check". Última falha: ' +
          describeError(lastFailure),
      );
    }

    await Bun.sleep(EMULATOR_RETRY_DELAY_MS);
  }
}

beforeAll(async () => {
  await waitForEmulator();

  const dlq = await client.send(
    new CreateQueueCommand({
      QueueName: dlqName,
      Attributes: { FifoQueue: 'true' },
    }),
  );
  dlqUrl = dlq.QueueUrl ?? '';
  expect(dlqUrl).not.toBe('');

  const dlqAttrs = await client.send(
    new GetQueueAttributesCommand({
      QueueUrl: dlqUrl,
      AttributeNames: ['QueueArn'],
    }),
  );
  const dlqArn = dlqAttrs.Attributes?.QueueArn ?? '';
  expect(dlqArn).not.toBe('');

  const main = await client.send(
    new CreateQueueCommand({
      QueueName: mainQueueName,
      Attributes: {
        FifoQueue: 'true',
        ContentBasedDeduplication: 'false',
        VisibilityTimeout: String(TEST_VISIBILITY_TIMEOUT),
        RedrivePolicy: JSON.stringify({
          deadLetterTargetArn: dlqArn,
          maxReceiveCount: TEST_MAX_RECEIVE_COUNT,
        }),
      },
    }),
  );
  mainQueueUrl = main.QueueUrl ?? '';
  expect(mainQueueUrl).not.toBe('');
}, SETUP_BUDGET_MS);

afterAll(async () => {
  /*
    Apaga o que existir, mesmo que o setup tenha falhado no meio, e sem que
    uma falha de limpeza mascare o resultado dos testes. Fila de teste
    esquecida no emulador acumula a cada execução.
  */
  for (const queueUrl of [mainQueueUrl, dlqUrl]) {
    if (queueUrl === '') continue;

    try {
      await client.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
    } catch (error) {
      console.warn(
        `Limpeza: não foi possível apagar ${queueUrl} — ${describeError(error)}`,
      );
    }
  }

  client.destroy();
});

describe('SQS FIFO no emulador local', () => {
  it('cria a fila como FIFO e com RedrivePolicy apontando para a DLQ', async () => {
    const attrs = await client.send(
      new GetQueueAttributesCommand({
        QueueUrl: mainQueueUrl,
        AttributeNames: ['FifoQueue', 'RedrivePolicy'],
      }),
    );

    expect(attrs.Attributes?.FifoQueue).toBe('true');

    const redrive = JSON.parse(attrs.Attributes?.RedrivePolicy ?? '{}') as {
      maxReceiveCount?: number;
      deadLetterTargetArn?: string;
    };
    expect(redrive.maxReceiveCount).toBe(TEST_MAX_RECEIVE_COUNT);
    expect(redrive.deadLetterTargetArn).toContain(dlqName);
  });

  it('entrega, devolve e apaga uma mensagem com MessageGroupId', async () => {
    const body = JSON.stringify({ type: 'WagerTransactionRequested', n: 1 });

    await client.send(
      new SendMessageCommand({
        QueueUrl: mainQueueUrl,
        MessageBody: body,
        MessageGroupId: 'wallet-1',
        MessageDeduplicationId: `entrega-${suffix}`,
      }),
    );

    const received = await receiveOne(mainQueueUrl, 5);
    expect(received).toBeDefined();
    expect(received?.body).toBe(body);

    await client.send(
      new DeleteMessageCommand({
        QueueUrl: mainQueueUrl,
        ReceiptHandle: received?.receiptHandle ?? '',
      }),
    );

    const afterDelete = await receiveOne(mainQueueUrl, 1);
    expect(afterDelete).toBeUndefined();
  });

  it('deduplica envios com o mesmo MessageDeduplicationId', async () => {
    const deduplicationId = `dedup-${suffix}`;
    const body = JSON.stringify({ type: 'WagerTransactionRequested', n: 2 });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await client.send(
        new SendMessageCommand({
          QueueUrl: mainQueueUrl,
          MessageBody: body,
          MessageGroupId: 'wallet-2',
          MessageDeduplicationId: deduplicationId,
        }),
      );
    }

    const first = await receiveOne(mainQueueUrl, 5);
    expect(first).toBeDefined();
    await client.send(
      new DeleteMessageCommand({
        QueueUrl: mainQueueUrl,
        ReceiptHandle: first?.receiptHandle ?? '',
      }),
    );

    const second = await receiveOne(mainQueueUrl, 2);
    expect(second).toBeUndefined();
  });

  it('move para a DLQ depois de esgotar maxReceiveCount', async () => {
    const body = JSON.stringify({ type: 'WagerTransactionRequested', n: 3 });

    await client.send(
      new SendMessageCommand({
        QueueUrl: mainQueueUrl,
        MessageBody: body,
        MessageGroupId: 'wallet-3',
        MessageDeduplicationId: `dlq-${suffix}`,
      }),
    );

    /*
      Recebe sem apagar: cada recebimento incrementa o ReceiveCount e, passado
      o visibility timeout, a mensagem volta a ficar visível.
    */
    for (let attempt = 0; attempt < TEST_MAX_RECEIVE_COUNT + 2; attempt += 1) {
      await receiveOne(mainQueueUrl, 2);
    }

    let moved: { body: string; receiptHandle: string } | undefined;
    for (let attempt = 0; attempt < 10 && moved === undefined; attempt += 1) {
      moved = await receiveOne(dlqUrl, 2);
    }

    expect(moved).toBeDefined();
    expect(moved?.body).toBe(body);
  }, 60_000);
});
