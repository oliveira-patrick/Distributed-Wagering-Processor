/*
  Cria as filas da aplicação no emulador local.

    bun run queues:bootstrap

  São dois pares: a fila de entrada, por onde os provedores submetem
  operações, e a fila de saída, por onde a outbox
  publica os eventos de integração — cada uma com a sua DLQ.

  Idempotente: rodar duas vezes não quebra e reconcilia os atributos.
*/
import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  SetQueueAttributesCommand,
} from '@aws-sdk/client-sqs';
import type { SQSClient } from '@aws-sdk/client-sqs';

import { createSqsClient } from '../src/infrastructure/messaging/sqs.client';
import {
  deadLetterQueueAttributes,
  eventsQueueAttributes,
  mainQueueAttributes,
} from '../src/infrastructure/messaging/queue-topology';

function env(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Variável de ambiente ausente: ${name}`);
  }
  return value;
}

// Cria a fila ou, se já existir, reconcilia os atributos.
async function ensureQueue(
  client: SQSClient,
  queueName: string,
  attributes: Record<string, string>,
): Promise<string> {
  try {
    const created = await client.send(
      new CreateQueueCommand({ QueueName: queueName, Attributes: attributes }),
    );
    if (created.QueueUrl === undefined) {
      throw new Error(`CreateQueue não devolveu QueueUrl para ${queueName}`);
    }
    /*
      "pronta", e não "criada": o `CreateQueue` é idempotente quando os
      atributos coincidem — devolve a fila existente sem erro, e daqui não há
      como distinguir os dois casos. Dizer "criada" na segunda execução seria
      o script mentindo sobre o que fez.
    */
    console.log(`  pronta:    ${queueName}`);
    return created.QueueUrl;
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    const alreadyExists =
      name === 'QueueAlreadyExists' || name === 'QueueNameExists';
    if (!alreadyExists) {
      throw error;
    }

    const existing = await client.send(
      new GetQueueUrlCommand({ QueueName: queueName }),
    );
    if (existing.QueueUrl === undefined) {
      throw new Error(`GetQueueUrl não devolveu QueueUrl para ${queueName}`, {
        cause: error,
      });
    }

    // FifoQueue não é mutável depois da criação, os demais atributos são.
    const { FifoQueue: _fifo, ...mutable } = attributes;
    await client.send(
      new SetQueueAttributesCommand({
        QueueUrl: existing.QueueUrl,
        Attributes: mutable,
      }),
    );
    console.log(`  existente: ${queueName} (atributos reconciliados)`);
    return existing.QueueUrl;
  }
}

async function queueArn(client: SQSClient, queueUrl: string): Promise<string> {
  const result = await client.send(
    new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: ['QueueArn'],
    }),
  );
  const arn = result.Attributes?.QueueArn;
  if (arn === undefined) {
    throw new Error(`Não foi possível ler o QueueArn de ${queueUrl}`);
  }
  return arn;
}

/*
  Cria o par fila + DLQ, nessa ordem.

  A DLQ nasce primeiro porque a fila principal precisa do ARN dela na
  `RedrivePolicy`, e o ARN só existe depois da criação.
*/
async function ensurePair(
  client: SQSClient,
  queueName: string,
  deadLetterName: string,
  attributesFor: (deadLetterArn: string) => Record<string, string>,
): Promise<void> {
  const dlqUrl = await ensureQueue(
    client,
    deadLetterName,
    deadLetterQueueAttributes(),
  );
  const dlqArn = await queueArn(client, dlqUrl);
  const queueUrl = await ensureQueue(client, queueName, attributesFor(dlqArn));

  console.log(`    DLQ ARN:  ${dlqArn}`);
  console.log(`    DLQ URL:  ${dlqUrl}`);
  console.log(`    fila URL: ${queueUrl}`);
}

async function main(): Promise<void> {
  const endpoint = env('SQS_ENDPOINT', '');
  const client = createSqsClient({
    region: env('AWS_REGION'),
    accessKeyId: env('AWS_ACCESS_KEY_ID'),
    secretAccessKey: env('AWS_SECRET_ACCESS_KEY'),
    endpoint,
    requestTimeoutMs: Number(env('SQS_REQUEST_TIMEOUT_MS', '30000')),
    connectionTimeoutMs: Number(env('SQS_CONNECTION_TIMEOUT_MS', '3000')),
  });

  console.log(`Endpoint: ${endpoint === '' ? '(AWS real)' : endpoint}`);

  // Entrada: os comandos que os provedores submetem.
  await ensurePair(
    client,
    env('SQS_QUEUE_NAME'),
    env('SQS_DLQ_NAME'),
    mainQueueAttributes,
  );

  /*
    Saída: os eventos de integração que a outbox publica. Fila
    separada da de entrada — ver ADR-012.
  */
  await ensurePair(
    client,
    env('SQS_EVENTS_QUEUE_NAME'),
    env('SQS_EVENTS_DLQ_NAME'),
    eventsQueueAttributes,
  );

  console.log('');
  console.log('Filas prontas.');

  client.destroy();
}

await main();
