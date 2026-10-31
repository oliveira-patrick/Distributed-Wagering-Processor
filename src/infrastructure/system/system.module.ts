import { Module } from '@nestjs/common';

import { LOGGER } from '../../application/ports/logger.port';
import {
  METRICS,
  METRICS_EXPOSITION,
} from '../../application/ports/metrics.port';
import { PROVIDER_IDENTITY } from '../../application/ports/provider-identity.port';
import { CLOCK, ID_GENERATOR } from '../../application/ports/system.port';
import { EnvService } from '../../config/env.service';
import { JsonLogger } from '../observability/json-logger';
import { InMemoryMetricsRegistry } from '../observability/metrics.registry';
import {
  NoOpProviderIdentity,
  SystemClock,
  UuidGenerator,
} from './system.providers';

/*
  As portas de sistema: relógio, gerador de id, identidade, log e métricas.

  Módulo próprio porque os três pontos de entrada precisam delas — a API, o
  consumidor da fila e os workers. Deixá-las no módulo HTTP faria o
  consumidor importar HTTP para obter um relógio.

  O registry de métricas é registrado **uma vez** e exposto por dois tokens
  distintos, apontando para a mesma instância: `METRICS` para quem produz e
  `METRICS_EXPOSITION` para quem lê. Duas instâncias deixariam o `/metrics`
  respondendo zero para sempre, e o bug não daria sinal nenhum — é o tipo de
  erro que só aparece quando alguém abre o gráfico e não acredita nele.
*/
@Module({
  providers: [
    { provide: CLOCK, useClass: SystemClock },
    { provide: ID_GENERATOR, useClass: UuidGenerator },
    { provide: PROVIDER_IDENTITY, useClass: NoOpProviderIdentity },
    {
      provide: LOGGER,
      inject: [EnvService],
      useFactory: (env: EnvService): JsonLogger => new JsonLogger(env.logLevel),
    },
    {
      provide: InMemoryMetricsRegistry,
      useFactory: (): InMemoryMetricsRegistry => new InMemoryMetricsRegistry(),
    },
    { provide: METRICS, useExisting: InMemoryMetricsRegistry },
    { provide: METRICS_EXPOSITION, useExisting: InMemoryMetricsRegistry },
  ],
  exports: [
    CLOCK,
    ID_GENERATOR,
    PROVIDER_IDENTITY,
    LOGGER,
    METRICS,
    METRICS_EXPOSITION,
  ],
})
export class SystemModule {}
