import { Inject, Module } from '@nestjs/common';
import type { OnApplicationShutdown } from '@nestjs/common';
import { SQSClient } from '@aws-sdk/client-sqs';

import { EVENT_PUBLISHER } from '../../application/ports/event-publisher.port';
import { EnvService } from '../../config/env.service';
import { SqsEventPublisher } from './sqs-event-publisher';
import { SQS_CLIENT, createSqsClient } from './sqs.client';

/*
  Cliente SQS compartilhado.

  O cliente do SDK mantém um pool de conexões HTTP; criá-lo por chamada
  desperdiçaria handshakes. É destruído no shutdown para que o processo
  encerre sem sockets pendurados, o que importa no `SIGTERM`.
*/
@Module({
  providers: [
    {
      provide: SQS_CLIENT,
      inject: [EnvService],
      useFactory: (env: EnvService): SQSClient => createSqsClient(env.sqs),
    },
    {
      /*
        Publicador dos eventos de integração, apontado para a fila de saída —
        nunca para a de entrada, que carrega comandos. Ver ADR-012.
      */
      provide: EVENT_PUBLISHER,
      inject: [SQS_CLIENT, EnvService],
      useFactory: (client: SQSClient, env: EnvService): SqsEventPublisher =>
        new SqsEventPublisher(client, env.sqs.eventsQueueName),
    },
  ],
  exports: [SQS_CLIENT, EVENT_PUBLISHER],
})
export class MessagingModule implements OnApplicationShutdown {
  constructor(@Inject(SQS_CLIENT) private readonly client: SQSClient) {}

  onApplicationShutdown(): void {
    this.client.destroy();
  }
}
