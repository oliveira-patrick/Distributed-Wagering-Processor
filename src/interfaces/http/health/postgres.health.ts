import { EntityManager } from '@mikro-orm/postgresql';
import { Injectable } from '@nestjs/common';
import { HealthIndicatorService } from '@nestjs/terminus';
import type { HealthIndicatorResult } from '@nestjs/terminus';

import { EnvService } from '../../../config/env.service';
import { describeError } from '../../../shared/describe-error';
import { ABORT_GRACE_MS, withDeadline } from '../../../shared/with-deadline';

/*
  Readiness do PostgreSQL.

  Executa uma consulta trivial em vez de inspecionar o estado do pool: o
  pool pode se considerar saudável enquanto o banco recusa conexões. O que
  interessa é se uma consulta completa agora — e **agora** tem prazo, pelo
  mesmo motivo do SQS: um banco que aceita a conexão e não responde deixaria
  a sonda sem resposta, e um readiness que não responde é indistinguível de
  um processo quebrado.
*/
@Injectable()
export class PostgresHealthIndicator {
  constructor(
    private readonly health: HealthIndicatorService,
    private readonly env: EnvService,
    private readonly em: EntityManager,
  ) {}

  async check(key = 'postgres'): Promise<HealthIndicatorResult> {
    const session = this.health.check(key);
    const timeoutMs = this.env.health.timeoutMs;

    try {
      /*
        `withDeadline` não cancela a consulta: ela segue no servidor até
        terminar. Para um `select 1` isso é irrelevante — se ele não volta, o
        problema é a conexão, e nem um `statement_timeout` chegaria lá para
        ser aplicado. O que importa é que esta função responda.
      */
      await withDeadline(
        this.em.getConnection().execute('select 1'),
        timeoutMs + ABORT_GRACE_MS,
        'PostgreSQL select 1',
      );
      return session.up();
    } catch (error) {
      return session.down({ message: describeError(error) });
    }
  }
}
