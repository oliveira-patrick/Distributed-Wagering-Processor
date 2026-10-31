import { Inject, Injectable } from '@nestjs/common';
import type {
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { SQSClient } from '@aws-sdk/client-sqs';

import { LOGGER } from '../../application/ports/logger.port';
import type { LoggerPort } from '../../application/ports/logger.port';
import { METRICS } from '../../application/ports/metrics.port';
import type { MetricsPort } from '../../application/ports/metrics.port';
import { ConsumeWagerMessageUseCase } from '../../application/use-cases/consume-wager-message.use-case';
import { EnvService } from '../../config/env.service';
import { SQS_CLIENT } from '../../infrastructure/messaging/sqs.client';
import { SqsWagerConsumer } from '../../infrastructure/messaging/sqs-consumer';

/*
  Liga o consumidor ao ciclo de vida do processo.

  `onApplicationBootstrap`, e não o construtor: no construtor, o consumidor
  começaria a receber enquanto o resto do grafo de injeção ainda está sendo
  montado, e uma mensagem entregue nesse intervalo encontraria dependência
  pela metade.

  `onApplicationShutdown` é o que torna o `SIGTERM` gracioso de verdade —
  e só funciona porque o entrypoint chama `enableShutdownHooks()`.
*/
@Injectable()
export class ConsumerWorker
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly consumer: SqsWagerConsumer;

  constructor(
    @Inject(SQS_CLIENT) client: SQSClient,
    consume: ConsumeWagerMessageUseCase,
    env: EnvService,
    @Inject(LOGGER) private readonly logger: LoggerPort,
    @Inject(METRICS) metrics: MetricsPort,
  ) {
    this.consumer = new SqsWagerConsumer(
      client,
      consume,
      {
        queueName: env.sqs.queueName,
        deadLetterQueueName: env.sqs.deadLetterQueueName,
        maxMessages: env.workers.consumerMaxMessages,
        shutdownTimeoutMs: env.workers.shutdownTimeoutMs,
      },
      logger,
      metrics,
    );
  }

  onApplicationBootstrap(): void {
    this.consumer.start();
    this.logger.info('consumidor da fila iniciado');
  }

  async onApplicationShutdown(): Promise<void> {
    await this.consumer.stop();
    this.logger.info('consumidor da fila encerrado');
  }
}
