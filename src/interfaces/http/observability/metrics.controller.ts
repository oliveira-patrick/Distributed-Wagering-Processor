import { Controller, Get, Header, Inject } from '@nestjs/common';

import {
  METRICS_CONTENT_TYPE,
  METRICS_EXPOSITION,
} from '../../../application/ports/metrics.port';
import type { MetricsExposition } from '../../../application/ports/metrics.port';

/*
  `GET /metrics` — as métricas de operação.

  Aberto, como os health checks: um coletor não carrega credencial de
  provedor, e métrica é superfície de operação, não de
  negócio. Nada do que sai aqui é dado financeiro — o catálogo de métricas só
  admite rótulos de identificação e contagens, nunca valor monetário.

  O `Content-Type` sai da mesma constante que o adapter usa para serializar,
  de modo que cabeçalho e corpo não possam divergir. `no-store` porque a
  resposta é um instantâneo: cache de métrica é métrica errada.
*/
@Controller()
export class MetricsController {
  constructor(
    @Inject(METRICS_EXPOSITION)
    private readonly exposition: MetricsExposition,
  ) {}

  @Get('metrics')
  @Header('Content-Type', METRICS_CONTENT_TYPE)
  @Header('Cache-Control', 'no-store')
  metrics(): string {
    return this.exposition.render();
  }
}
