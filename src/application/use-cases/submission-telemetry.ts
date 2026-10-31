import { Metric } from '../ports/metrics.port';
import type { MetricSource, MetricsPort } from '../ports/metrics.port';
import type { SubmitWagerTransactionResult } from './submit-wager-transaction.use-case';

/*
  A operação que produziu o desfecho, para o rótulo da latência.

  Três, e não uma: o consumidor reusa o mesmo caso de uso do HTTP, e com um
  rótulo só as três curvas viram uma. Uma submissão HTTP
  lenta e um worker de referência lento pedem reações diferentes.
*/
export const SubmissionOperation = {
  Submit: 'submit',
  Consume: 'consume',
  Reference: 'reference',
} as const;

export type SubmissionOperation =
  (typeof SubmissionOperation)[keyof typeof SubmissionOperation];

/*
  Registra o desfecho de uma submissão nas métricas de operação.

  Função, e não método do caso de uso, porque os três chamadores vivem em
  lugares diferentes — controller HTTP, consumidor da fila e worker de
  referência — e todos precisam registrar **depois do commit**. Dentro da
  transação, um desfecho que depois revertesse já teria sido contado, e a
  métrica passaria a divergir do banco justamente no cenário em que alguém
  vai olhá-la.
*/
export function recordSubmission(
  metrics: MetricsPort,
  source: MetricSource,
  operation: SubmissionOperation,
  result: SubmitWagerTransactionResult,
  seconds: number,
): void {
  if (result.outcome === 'refused') {
    /*
      Recusa anterior à transação não tem `kind` conhecido do domínio nem
      linha persistida; o que se sabe é que o provedor foi recusado.
    */
    metrics.increment(Metric.TransactionsTotal, {
      kind: 'UNKNOWN',
      status: 'REFUSED',
      source,
    });
    metrics.observe(Metric.ProcessingDurationSeconds, seconds, {
      operation,
      outcome: 'refused',
    });
    return;
  }

  metrics.increment(Metric.TransactionsTotal, {
    kind: result.transaction.kind,
    status: result.transaction.status,
    source,
  });

  if (result.idempotentReplay) {
    /*
      Duplicata recusada pela unicidade em `(idempotency_key)`, a garantia
      persistente, nunca um cache em memória.
    */
    metrics.increment(Metric.DuplicatesTotal, { guard: 'idempotency' });
  }

  metrics.observe(Metric.ProcessingDurationSeconds, seconds, {
    operation,
    outcome: result.idempotentReplay ? 'replay' : result.transaction.status,
  });
}
