/*
  Verifica, de fora da aplicação, se a infraestrutura local responde.

   bun run infra:check

  Existe para separar "a aplicação está quebrada" de "a infraestrutura não
  subiu", a primeira pergunta a fazer quando algo falha localmente. Sai com
  código diferente de zero se qualquer verificação falhar, para poder ser
  encadeado em scripts.
*/
import {
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
} from '@aws-sdk/client-sqs';
import { MikroORM } from '@mikro-orm/postgresql';

import { createSqsClient } from '../src/infrastructure/messaging/sqs.client';
import { buildMikroOrmConfig } from '../src/infrastructure/persistence/mikro-orm.config';
import { describeError } from '../src/shared/describe-error';

function env(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Variável de ambiente ausente: ${name}`);
  }
  return value;
}

interface CheckResult {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

async function checkPostgres(): Promise<CheckResult> {
  const host = env('POSTGRES_HOST');
  const port = Number(env('POSTGRES_PORT'));
  let orm: MikroORM | undefined;
  try {
    orm = await MikroORM.init(
      buildMikroOrmConfig(
        {
          host,
          port,
          user: env('POSTGRES_USER'),
          password: env('POSTGRES_PASSWORD'),
          database: env('POSTGRES_DB'),
        },
        { debug: false },
      ),
    );
    const rows = await orm.em
      .getConnection()
      .execute<{ version: string }[]>('select version() as version');
    const version = rows[0]?.version ?? '(desconhecida)';
    return {
      name: `PostgreSQL ${host}:${String(port)}`,
      ok: true,
      detail: version.split(',')[0] ?? version,
    };
  } catch (error) {
    return {
      name: `PostgreSQL ${host}:${String(port)}`,
      ok: false,
      detail: describeError(error),
    };
  } finally {
    await orm?.close(true);
  }
}

/*
  Confere uma fila: existe, é FIFO e tem DLQ.

  Parametrizada pelo nome porque agora há duas filas que a aplicação precisa
  encontrar — a de entrada e a de saída dos eventos. Checar só uma delas
  deixava passar o caso em que o publicador da outbox não tem para onde
  publicar, e o sintoma seria "evento sumiu" muito depois.
*/
async function checkSqsQueue(queueName: string): Promise<CheckResult> {
  const endpoint = env('SQS_ENDPOINT', '');
  const client = createSqsClient({
    region: env('AWS_REGION'),
    accessKeyId: env('AWS_ACCESS_KEY_ID'),
    secretAccessKey: env('AWS_SECRET_ACCESS_KEY'),
    endpoint,
    requestTimeoutMs: Number(env('SQS_REQUEST_TIMEOUT_MS', '30000')),
    connectionTimeoutMs: Number(env('SQS_CONNECTION_TIMEOUT_MS', '3000')),
  });

  try {
    const { QueueUrl } = await client.send(
      new GetQueueUrlCommand({ QueueName: queueName }),
    );
    if (QueueUrl === undefined) {
      return {
        name: `SQS ${queueName}`,
        ok: false,
        detail: 'fila não encontrada',
      };
    }
    const attrs = await client.send(
      new GetQueueAttributesCommand({
        QueueUrl,
        AttributeNames: ['FifoQueue', 'RedrivePolicy'],
      }),
    );
    const fifo = attrs.Attributes?.FifoQueue ?? 'false';
    const redrive = attrs.Attributes?.RedrivePolicy ?? '(sem DLQ)';
    return {
      name: `SQS ${queueName}`,
      ok: true,
      detail: `FIFO=${fifo} redrive=${redrive}`,
    };
  } catch (error) {
    return {
      name: `SQS ${queueName}`,
      ok: false,
      detail: describeError(error),
    };
  } finally {
    client.destroy();
  }
}

const results = await Promise.all([
  checkPostgres(),
  checkSqsQueue(env('SQS_QUEUE_NAME')),
  checkSqsQueue(env('SQS_EVENTS_QUEUE_NAME')),
]);

for (const result of results) {
  console.log(`${result.ok ? '  OK  ' : ' FALHA'}  ${result.name}`);
  console.log(`        ${result.detail}`);
}

const failed = results.filter((r) => !r.ok);
if (failed.length > 0) {
  console.error(`\n${String(failed.length)} verificação(ões) falharam.`);
  process.exit(1);
}
console.log('\nInfraestrutura acessível.');
