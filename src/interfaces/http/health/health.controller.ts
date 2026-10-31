import { Controller, Get } from '@nestjs/common';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';
import type {
  HealthCheckResult,
  HealthIndicatorResult,
} from '@nestjs/terminus';

import { PostgresHealthIndicator } from './postgres.health';
import { SqsHealthIndicator } from './sqs.health';

interface LivenessResult {
  readonly status: 'ok';
  readonly uptimeSeconds: number;
  readonly timestamp: string;
}

/*
  Liveness e readiness são endpoints separados porque respondem a perguntas
  diferentes, e confundi-las custa caro: um liveness que consulta o banco faz
  o orquestrador reiniciar uma aplicação saudável toda vez que o PostgreSQL
  oscila — exatamente quando reiniciar é a pior reação possível.

  Nenhum dos dois exige autenticação.
*/
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly postgres: PostgresHealthIndicator,
    private readonly sqs: SqsHealthIndicator,
  ) {}

  // O processo está vivo e respondendo. Não toca em dependência alguma.
  @Get('live')
  live(): LivenessResult {
    return {
      status: 'ok',
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    };
  }

  // As dependências necessárias para atender tráfego estão alcançáveis.
  @Get('ready')
  @HealthCheck()
  ready(): Promise<HealthCheckResult> {
    return this.health.check([
      (): Promise<HealthIndicatorResult> => this.postgres.check(),
      (): Promise<HealthIndicatorResult> => this.sqs.check(),
    ]);
  }
}
