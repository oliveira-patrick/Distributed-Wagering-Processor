import { Inject, Injectable } from '@nestjs/common';
import type {
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';

import { LOGGER } from '../../application/ports/logger.port';
import type { LoggerPort } from '../../application/ports/logger.port';
import { RetryPendingReferenceUseCase } from '../../application/use-cases/retry-pending-reference.use-case';
import { EnvService } from '../../config/env.service';
import { describeError } from '../../shared/describe-error';
import { isTransportFailure } from '../../shared/transport-failure';
import { PollingLoop } from './polling-loop';
import type { TickOutcome } from './polling-loop';

/*
  Reavalia as transações em `PENDING_REFERENCE`, seguindo a agenda.

  O intervalo de varredura é bem mais folgado que o do publicador de outbox,
  e de propósito: a menor espera da agenda é de onze minutos, então varrer de
  segundo em segundo só produziria consulta vazia. O índice parcial de
  pendentes vencidas torna a consulta barata mesmo assim.
*/
@Injectable()
export class PendingReferenceWorker
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly loop: PollingLoop;
  private readonly shutdownTimeoutMs: number;

  constructor(
    private readonly retryPendingReference: RetryPendingReferenceUseCase,
    env: EnvService,
    @Inject(LOGGER) private readonly logger: LoggerPort,
  ) {
    this.shutdownTimeoutMs = env.workers.shutdownTimeoutMs;
    this.loop = new PollingLoop(
      () => this.tick(),
      (error) => {
        this.logger.error('passada do worker de referência falhou', {
          transient: isTransportFailure(error),
          detail: describeError(error),
        });
      },
      { idleDelayMs: env.workers.referencePollIntervalMs },
    );
  }

  onApplicationBootstrap(): void {
    this.loop.start();
    this.logger.info('worker de referência pendente iniciado');
  }

  async onApplicationShutdown(): Promise<void> {
    const clean = await this.loop.stop(this.shutdownTimeoutMs);
    this.logger.info('worker de referência pendente encerrado', { clean });
  }

  private async tick(): Promise<TickOutcome> {
    const result = await this.retryPendingReference.retryDue();

    if (result.examined > 0) {
      this.logger.info('referências pendentes reavaliadas', {
        examined: result.examined,
        applied: result.applied,
        rejected: result.rejected,
        stillWaiting: result.stillWaiting,
      });
    }

    /*
      Lote cheio sugere que há mais vencido esperando; qualquer outra coisa
      significa que a fila de vencidas secou.
    */
    return result.examined === 0 ? 'idle' : 'again';
  }
}
