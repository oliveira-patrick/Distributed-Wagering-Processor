/*
  Filas descartáveis, por arquivo de teste.

  Nomes únicos por execução: nenhum teste encosta nas filas da aplicação. O
  `destroy` apaga o que existir mesmo que o setup tenha falhado no meio —
  fila esquecida no emulador acumula a cada execução.
*/
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ListQueuesCommand,
} from '@aws-sdk/client-sqs';
import type { SQSClient } from '@aws-sdk/client-sqs';

import { createSqsClient } from '../../../src/infrastructure/messaging/sqs.client';
import { describeError } from '../../../src/shared/describe-error';

function env(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Variável ausente: ${name}`);
  }
  return value;
}

// Quanto se espera por um emulador que acabou de subir.
const EMULATOR_BUDGET_MS = 60_000;
const EMULATOR_RETRY_DELAY_MS = 500;

export function createTestSqsClient(): SQSClient {
  return createSqsClient({
    region: env('AWS_REGION'),
    accessKeyId: env('AWS_ACCESS_KEY_ID'),
    secretAccessKey: env('AWS_SECRET_ACCESS_KEY'),
    endpoint: env('SQS_ENDPOINT', ''),
    requestTimeoutMs: Number(env('SQS_REQUEST_TIMEOUT_MS', '30000')),
    connectionTimeoutMs: Number(env('SQS_CONNECTION_TIMEOUT_MS', '3000')),
  });
}

/*
  Espera o emulador atender antes de montar o cenário.

  `ListQueues` basta como sonda: qualquer resposta prova que o transporte
  está de pé, que é o que se espera aqui. Sem esta espera, um container frio
  reprova a suíte por um motivo que nada tem a ver com o que ela verifica.
*/
export async function waitForEmulator(client: SQSClient): Promise<void> {
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

export interface TestQueuePair {
  readonly name: string;
  readonly url: string;
  readonly deadLetterName: string;
  readonly deadLetterUrl: string;
}

export interface TestQueues {
  readonly client: SQSClient;
  // Fila de entrada: os comandos submetidos pelos provedores.
  readonly input: TestQueuePair;
  // Fila de saída: os eventos de integração publicados pela outbox.
  readonly events: TestQueuePair;
  // Exporta os nomes para `process.env`, antes de importar a aplicação.
  applyToEnv(): void;
  destroy(): Promise<void>;
}

export interface TestQueueOptions {
  // Curto nos testes: redelivery e DLQ precisam acontecer rápido.
  readonly visibilityTimeoutSeconds?: number;
  readonly maxReceiveCount?: number;
}

async function arnOf(client: SQSClient, queueUrl: string): Promise<string> {
  const result = await client.send(
    new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: ['QueueArn'],
    }),
  );
  const arn = result.Attributes?.QueueArn;
  if (arn === undefined || arn === '') {
    throw new Error(`não foi possível ler o QueueArn de ${queueUrl}`);
  }
  return arn;
}

async function createPair(
  client: SQSClient,
  prefix: string,
  options: TestQueueOptions,
): Promise<TestQueuePair> {
  const deadLetterName = `${prefix}-dlq.fifo`;
  const name = `${prefix}.fifo`;

  const dlq = await client.send(
    new CreateQueueCommand({
      QueueName: deadLetterName,
      Attributes: { FifoQueue: 'true' },
    }),
  );
  const deadLetterUrl = dlq.QueueUrl ?? '';
  if (deadLetterUrl === '') {
    throw new Error(`CreateQueue não devolveu URL para ${deadLetterName}`);
  }

  const main = await client.send(
    new CreateQueueCommand({
      QueueName: name,
      Attributes: {
        FifoQueue: 'true',
        ContentBasedDeduplication: 'false',
        VisibilityTimeout: String(options.visibilityTimeoutSeconds ?? 5),
        RedrivePolicy: JSON.stringify({
          deadLetterTargetArn: await arnOf(client, deadLetterUrl),
          maxReceiveCount: options.maxReceiveCount ?? 3,
        }),
      },
    }),
  );
  const url = main.QueueUrl ?? '';
  if (url === '') {
    throw new Error(`CreateQueue não devolveu URL para ${name}`);
  }

  return { name, url, deadLetterName, deadLetterUrl };
}

export async function createTestQueues(
  suffix: string,
  options: TestQueueOptions = {},
): Promise<TestQueues> {
  const client = createTestSqsClient();
  await waitForEmulator(client);

  const unique = `${String(Date.now())}-${String(
    Math.floor(Math.random() * 10_000),
  )}`;
  const prefix = `test-${suffix}-${unique}`;

  const input = await createPair(client, `${prefix}-in`, options);
  const events = await createPair(client, `${prefix}-ev`, options);

  return {
    client,
    input,
    events,
    applyToEnv: (): void => {
      process.env.SQS_QUEUE_NAME = input.name;
      process.env.SQS_DLQ_NAME = input.deadLetterName;
      process.env.SQS_EVENTS_QUEUE_NAME = events.name;
      process.env.SQS_EVENTS_DLQ_NAME = events.deadLetterName;
    },
    destroy: async (): Promise<void> => {
      const urls = [
        input.url,
        input.deadLetterUrl,
        events.url,
        events.deadLetterUrl,
      ];

      await Promise.allSettled(
        urls.map((url) =>
          client.send(new DeleteQueueCommand({ QueueUrl: url })),
        ),
      );
      client.destroy();
    },
  };
}
