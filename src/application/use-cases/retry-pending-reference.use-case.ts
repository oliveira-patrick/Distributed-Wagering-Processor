import { WagerTransactionStatus } from '../../domain/wagering/wager-transaction-status';
import type { LoggerPort } from '../ports/logger.port';
import { Metric, MetricSource } from '../ports/metrics.port';
import type { MetricsPort } from '../ports/metrics.port';
import type { Clock, IdGenerator } from '../ports/system.port';
import type { UnitOfWork } from '../ports/unit-of-work';
import { SubmissionOperation, recordSubmission } from './submission-telemetry';
import type { SubmitWagerTransactionUseCase } from './submit-wager-transaction.use-case';

export interface RetryPendingReferenceResult {
  readonly examined: number;
  readonly applied: number;
  readonly rejected: number;
  readonly stillWaiting: number;
}

/*
  Reavalia as transações que esperam uma referência aparecer.

  **Uma transação SQL por transação de negócio, não uma por lote.** A
  diferença importa de dois modos. Primeiro, o isolamento: uma transação que
  falhe por violação de constraint aborta a transação SQL inteira no
  PostgreSQL, e num lote compartilhado ela levaria consigo as outras
  dezenove. Segundo, a duração: aplicar o efeito tardio exige o lock da
  wallet, e um lote inteiro numa transação só manteria vinte wallets
  travadas enquanto a API espera por elas.

  O custo é uma ida ao banco por item em vez de uma por lote — irrelevante
  para um worker cuja menor espera de agenda é de onze minutos.

  O `findDueForReference` usa `for update skip locked`, então vários workers
  concorrentes pegam transações disjuntas sem lock global. Ver ADR-013.
*/
export class RetryPendingReferenceUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly submit: SubmitWagerTransactionUseCase,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly logger: LoggerPort,
    private readonly metrics: MetricsPort,
    private readonly batchSize: number,
  ) {}

  async retryDue(): Promise<RetryPendingReferenceResult> {
    let examined = 0;
    let applied = 0;
    let rejected = 0;
    let stillWaiting = 0;

    while (examined < this.batchSize) {
      const outcome = await this.retryOne();

      if (outcome === 'empty') {
        break;
      }

      examined += 1;
      if (outcome === 'applied') {
        applied += 1;
      } else if (outcome === 'rejected') {
        rejected += 1;
      } else {
        stillWaiting += 1;
      }
    }

    return { examined, applied, rejected, stillWaiting };
  }

  /*
    Uma transação de negócio, numa transação SQL própria.

    Reivindica **uma** linha vencida com `skip locked` e a processa. Como o
    lock vale até o commit, e o commit acontece no fim desta chamada, duas
    instâncias nunca trabalham sobre a mesma transação.
  */
  private async retryOne(): Promise<
    'empty' | 'applied' | 'rejected' | 'waiting'
  > {
    const startedAt = this.clock.now().getTime();
    const correlationId = this.ids.next();

    const outcome = await this.unitOfWork.run(async (repositories) => {
      const due = await repositories.transactions.findDueForReference(
        this.clock.now(),
        1,
      );

      const transaction = due[0];
      if (transaction === undefined) {
        return undefined;
      }

      const result = await this.submit.retryReferenceWithin(
        repositories,
        transaction,
        correlationId,
      );

      return { transaction, result };
    });

    if (outcome === undefined) {
      return 'empty';
    }

    // Depois do commit: antes, um rollback já teria sido contado.
    recordSubmission(
      this.metrics,
      MetricSource.Worker,
      SubmissionOperation.Reference,
      outcome.result,
      (this.clock.now().getTime() - startedAt) / 1_000,
    );

    const status = outcome.transaction.status;

    if (status === WagerTransactionStatus.Processed) {
      this.logger.info('referência pendente resolvida e aplicada', {
        correlationId,
        transactionId: outcome.transaction.id,
        walletId: outcome.transaction.walletId,
        providerId: outcome.transaction.providerId,
        attempts: outcome.transaction.referenceAttempts,
      });
      return 'applied';
    }

    if (status === WagerTransactionStatus.Rejected) {
      this.logger.warn('referência pendente recusada em definitivo', {
        correlationId,
        transactionId: outcome.transaction.id,
        walletId: outcome.transaction.walletId,
        providerId: outcome.transaction.providerId,
        failureCode: outcome.transaction.failureCode,
        attempts: outcome.transaction.referenceAttempts,
      });
      return 'rejected';
    }

    this.metrics.increment(Metric.RetriesTotal, { subject: 'reference' });
    return 'waiting';
  }
}
