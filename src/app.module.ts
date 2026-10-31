import { Module } from '@nestjs/common';

import { ConfigModule } from './config/config.module';
import { MessagingModule } from './infrastructure/messaging/messaging.module';
import { PersistenceModule } from './infrastructure/persistence/persistence.module';
import { ApiModule } from './interfaces/http/api.module';
import { HealthModule } from './interfaces/http/health/health.module';
import { ObservabilityModule } from './interfaces/http/observability/observability.module';

/*
  Raiz de composição.

  `ApiModule` traz os sete endpoints de negócio e, por trás deles, os casos de
  uso compostos em `infrastructure/composition`. O consumidor da fila e os
  workers de outbox e de referência pendente **não** sobem aqui: eles vivem no
  `WorkerModule`, e reaproveitam os mesmos casos de uso — é por isso que a
  composição deles não mora dentro do módulo HTTP.
*/
@Module({
  imports: [
    ConfigModule,
    PersistenceModule,
    MessagingModule,
    HealthModule,
    ObservabilityModule,
    ApiModule,
  ],
})
export class AppModule {}
