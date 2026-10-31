import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';

import { LOGGER } from './application/ports/logger.port';
import type { LoggerPort } from './application/ports/logger.port';
import { EnvService } from './config/env.service';
import { WorkerModule } from './worker.module';

/*
  Entrypoint do processo de trabalho de fundo.

    bun run worker

  Sobe o consumidor da fila, o publicador da outbox e o worker de referência
  pendente, mais uma porta HTTP só para `/health` e `/metrics`.

  A porta existe por uma razão operacional: um worker sem sonda é
  indistinguível de um worker travado, e sem `/metrics` as métricas que só
  ele produz — outbox lag, retries, DLQ — não chegariam a lugar nenhum. É
  outra porta que a da API porque os dois rodam no mesmo host durante os
  testes de concorrência.
*/
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(WorkerModule, { bufferLogs: true });

  /*
    Sem isto, `onApplicationShutdown` não roda: o `SIGTERM` mataria o
    processo com mensagens em andamento, sem devolver a visibilidade delas.
  */
  app.enableShutdownHooks();

  const env = app.get(EnvService);
  const logger = app.get<LoggerPort>(LOGGER);

  await app.listen(env.workerPort);

  logger.info('worker no ar', {
    port: env.workerPort,
    nodeEnv: env.nodeEnv,
    consumerName: env.sqs.consumerName,
  });
}

await bootstrap();
