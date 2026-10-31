import { Module } from '@nestjs/common';

import { ConfigModule } from './config/config.module';
import { MessagingModule } from './infrastructure/messaging/messaging.module';
import { PersistenceModule } from './infrastructure/persistence/persistence.module';
import { HealthModule } from './interfaces/http/health/health.module';
import { ObservabilityModule } from './interfaces/http/observability/observability.module';
import { WorkersModule } from './interfaces/workers/workers.module';

/*
  Raiz de composição do processo de trabalho de fundo.

  Mesma aplicação da API, papel diferente conforme o entrypoint — é o que o
  ADR-001 decidiu. O que muda em relação ao `AppModule` é só o que entra:
  aqui não há `ApiModule`, e em troca há `WorkersModule`.

  `HealthModule` e `ObservabilityModule` entram porque um worker também
  precisa ser sondado e medido. Sem eles, o orquestrador não distingue um
  worker travado de um worker ocioso, e as métricas que só o worker
  produz — outbox lag, retries, DLQ — não teriam por onde sair.
*/
@Module({
  imports: [
    ConfigModule,
    PersistenceModule,
    MessagingModule,
    HealthModule,
    ObservabilityModule,
    WorkersModule,
  ],
})
export class WorkerModule {}
