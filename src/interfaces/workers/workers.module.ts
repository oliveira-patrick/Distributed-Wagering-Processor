import { Module } from '@nestjs/common';

import { UseCasesModule } from '../../infrastructure/composition/use-cases.module';
import { MessagingModule } from '../../infrastructure/messaging/messaging.module';
import { SystemModule } from '../../infrastructure/system/system.module';
import { ConsumerWorker } from './consumer.worker';
import { OutboxWorker } from './outbox.worker';
import { PendingReferenceWorker } from './pending-reference.worker';

/*
  Todo o trabalho de fundo, num módulo só.

  O consumidor da fila, o publicador da outbox e o worker de referência
  pendente sobem juntos, no entrypoint `src/worker.ts`. Separá-los em três
  processos seria a decisão certa se cada um precisasse de escala própria, e
  hoje nenhum precisa: os três são limitados pelo mesmo PostgreSQL. A costura
  para separá-los existe e é este módulo — ver ADR-001 e ADR-013.

  O que **não** sobe aqui são os controllers. Um worker que também responde
  às requisições de negócio não é um worker; é a API com trabalho extra, e
  uma rajada de apostas passaria a atrasar a publicação de eventos.
*/
@Module({
  imports: [UseCasesModule, MessagingModule, SystemModule],
  providers: [ConsumerWorker, OutboxWorker, PendingReferenceWorker],
})
export class WorkersModule {}
