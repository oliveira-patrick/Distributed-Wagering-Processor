import { Inject, Injectable } from '@nestjs/common';
import type {
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';

import { LOGGER } from '../../application/ports/logger.port';
import type { LoggerPort } from '../../application/ports/logger.port';
import { PublishOutboxUseCase } from '../../application/use-cases/publish-outbox.use-case';
import { EnvService } from '../../config/env.service';
import { describeError } from '../../shared/describe-error';
import { isTransportFailure } from '../../shared/transport-failure';
import { PollingLoop } from './polling-loop';
import type { TickOutcome } from './polling-loop';

/*
  Publica os eventos pendentes da outbox, continuamente.

  Várias instâncias deste worker podem rodar ao mesmo tempo, e é o que o
  cenário de recuperação exige: o processo morre depois do commit, outra
  instância assume, o evento é publicado. A coordenação é por
  `for update skip locked` no banco — nada de lock distribuído, nada de
  eleição de líder.

  O lag é medido a cada passada, e não a cada N passadas: a consulta é
  `count` e `min` sobre o índice parcial de pendentes, barata, e uma métrica
  de lag atualizada a cada cinco segundos não serve de alarme.
*/
@Injectable()
export class OutboxWorker
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly loop: PollingLoop;
  private readonly shutdownTimeoutMs: number;

  constructor(
    private readonly publishOutbox: PublishOutboxUseCase,
    env: EnvService,
    @Inject(LOGGER) private readonly logger: LoggerPort,
  ) {
    this.shutdownTimeoutMs = env.workers.shutdownTimeoutMs;
    this.loop = new PollingLoop(
      () => this.tick(),
      (error) => {
        this.logger.error('passada do publicador de outbox falhou', {
          transient: isTransportFailure(error),
          detail: describeError(error),
        });
      },
      { idleDelayMs: env.workers.outboxPollIntervalMs },
    );
  }

  onApplicationBootstrap(): void {
    this.loop.start();
    this.logger.info('publicador de outbox iniciado');
  }

  async onApplicationShutdown(): Promise<void> {
    const clean = await this.loop.stop(this.shutdownTimeoutMs);
    this.logger.info('publicador de outbox encerrado', { clean });
  }

  private async tick(): Promise<TickOutcome> {
    const result = await this.publishOutbox.publishDue();
    await this.publishOutbox.reportLag();

    if (result.published > 0 || result.retried > 0) {
      this.logger.info('lote de outbox publicado', {
        claimed: result.claimed,
        published: result.published,
        retried: result.retried,
      });
    }

    /*
      Lote vazio é a única situação em que vale dormir. Lote com qualquer
      coisa dentro sugere que há mais vencido esperando.
    */
    return result.claimed === 0 ? 'idle' : 'again';
  }
}
