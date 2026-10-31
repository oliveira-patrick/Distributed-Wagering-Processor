/*
  Porta de métricas.

  O mínimo que a operação precisa ver: transações por status, duplicatas
  detectadas, retries, mensagens em DLQ, conflitos de lock, outbox lag e
  latência de processamento — mais a divergência de reconciliação, que
  precisa ser **contabilizada em métrica**, não só logada.

  O catálogo abaixo declara todas elas em um lugar só, com tipo e rótulos.
  Não é cerimônia: é o que permite ao registry emitir uma métrica **antes da
  primeira observação**. Série que só nasce quando o evento acontece faz o
  gráfico pular de "sem dados" para um valor, e quem olha não distingue "não
  aconteceu" de "não está instrumentado" — justamente a dúvida que a métrica
  existe para resolver.
*/

export const MetricKind = {
  Counter: 'counter',
  Gauge: 'gauge',
  Histogram: 'histogram',
} as const;

export type MetricKind = (typeof MetricKind)[keyof typeof MetricKind];

/*
  Rótulos de uma amostra.

  Só string — nunca número nem objeto —, para que a cardinalidade da série
  fique visível na chamada. `undefined` é aceito e **descartado**: muitos
  rótulos vêm de campos opcionais do domínio (um `failureCode` que só existe
  na recusa), e obrigar cada call site a montar o objeto condicionalmente
  trocaria uma linha de ruído por outra. O que não se aceita é o rótulo
  virar a string "undefined", que cria série paralela sem ninguém notar.
*/
export type MetricLabels = Readonly<Record<string, string | undefined>>;

export interface MetricDeclaration {
  readonly name: string;
  readonly kind: MetricKind;
  readonly help: string;
  // Rótulos permitidos. O registry recusa rótulo fora desta lista.
  readonly labels: readonly string[];
}

/*
  De onde a operação entrou no sistema.

  O consumidor reusa o mesmo caso de uso do HTTP, e é exatamente por isso
  que o rótulo existe: sem ele, as duas entradas viram
  uma série só e não há como ver que a fila parou de entregar.
*/
export const MetricSource = {
  Http: 'http',
  Sqs: 'sqs',
  Worker: 'worker',
} as const;

export type MetricSource = (typeof MetricSource)[keyof typeof MetricSource];

export const Metric = {
  TransactionsTotal: 'wagering_transactions_total',
  DuplicatesTotal: 'wagering_duplicates_detected_total',
  RetriesTotal: 'wagering_retries_total',
  DlqMessagesTotal: 'wagering_dlq_messages_total',
  LockConflictsTotal: 'wagering_lock_conflicts_total',
  OutboxPendingAgeSeconds: 'wagering_outbox_pending_age_seconds',
  OutboxPendingCount: 'wagering_outbox_pending_count',
  OutboxPublishedTotal: 'wagering_outbox_published_total',
  ProcessingDurationSeconds: 'wagering_processing_duration_seconds',
  ReconciliationChecksTotal: 'wagering_reconciliation_checks_total',
  MessagesReceivedTotal: 'wagering_messages_received_total',
} as const;

export type Metric = (typeof Metric)[keyof typeof Metric];

/*
  Buckets de latência, em segundos.

  Escala logarítmica de 1 ms a 10 s. O piso é 1 ms porque uma duplicata
  detectada pelo inbox termina sem tocar o domínio e precisa ser
  distinguível de zero; o teto é 10 s porque acima disso a operação já
  estourou o visibility timeout de 30 s dividido pelo lote, e o que importa
  saber é só que ela passou do aceitável — para isso basta o `+Inf`.
*/
export const LATENCY_BUCKETS_SECONDS: readonly number[] = [
  0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
];

export const METRICS_CATALOG: readonly MetricDeclaration[] = [
  {
    name: Metric.TransactionsTotal,
    kind: MetricKind.Counter,
    help: 'Transações por tipo, status final e origem da entrada.',
    labels: ['kind', 'status', 'source'],
  },
  {
    name: Metric.DuplicatesTotal,
    kind: MetricKind.Counter,
    help: 'Duplicatas recusadas pela idempotência persistente ou pelo inbox.',
    labels: ['guard'],
  },
  {
    name: Metric.RetriesTotal,
    kind: MetricKind.Counter,
    help: 'Retentativas agendadas, por assunto.',
    labels: ['subject'],
  },
  {
    name: Metric.DlqMessagesTotal,
    kind: MetricKind.Counter,
    help: 'Mensagens enviadas à DLQ, por motivo.',
    labels: ['reason'],
  },
  {
    name: Metric.LockConflictsTotal,
    kind: MetricKind.Counter,
    help: 'Conflitos de concorrência observados no banco, por assunto.',
    labels: ['subject'],
  },
  {
    name: Metric.OutboxPendingAgeSeconds,
    kind: MetricKind.Gauge,
    help: 'Outbox lag: idade do evento pendente mais antigo, em segundos.',
    labels: [],
  },
  {
    name: Metric.OutboxPendingCount,
    kind: MetricKind.Gauge,
    help: 'Eventos ainda não publicados na outbox.',
    labels: [],
  },
  {
    name: Metric.OutboxPublishedTotal,
    kind: MetricKind.Counter,
    help: 'Eventos publicados pelo worker de outbox, por desfecho.',
    labels: ['outcome'],
  },
  {
    name: Metric.ProcessingDurationSeconds,
    kind: MetricKind.Histogram,
    help: 'Latência de processamento por operação e desfecho, em segundos.',
    labels: ['operation', 'outcome'],
  },
  {
    name: Metric.ReconciliationChecksTotal,
    kind: MetricKind.Counter,
    help: 'Reconciliações executadas, separando consistente de divergente.',
    labels: ['result'],
  },
  {
    name: Metric.MessagesReceivedTotal,
    kind: MetricKind.Counter,
    help: 'Mensagens recebidas da fila, por desfecho do processamento.',
    labels: ['outcome'],
  },
];

/*
  Registro de métricas.

  Deliberadamente sem `toText()` nem nada de exposição: quem produz métrica
  não precisa saber como ela é lida, e manter a serialização fora da porta é
  o que permite trocar o formato — ou passar a empurrar para um coletor — sem
  tocar em caso de uso nenhum.
*/
export interface MetricsPort {
  increment(name: Metric, labels?: MetricLabels, by?: number): void;
  gauge(name: Metric, value: number, labels?: MetricLabels): void;
  // Observa uma duração em **segundos**, não em milissegundos.
  observe(name: Metric, seconds: number, labels?: MetricLabels): void;
}

export const METRICS = 'METRICS';

/*
  Formato de exposição.

  Declarado aqui, e não no adapter nem no controller, porque os dois precisam
  concordar: o adapter serializa neste formato e o controller o anuncia no
  `Content-Type`. Com a constante em um lugar só, trocar de formato é uma
  edição; com ela duplicada, o cabeçalho passa a mentir sobre o corpo, e o
  coletor rejeita a resposta sem dizer por quê.

  `version=0.0.4` é o formato de texto do Prometheus.
*/
export const METRICS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

/*
  Porta de **exposição**, separada da de produção.

  Quem produz métrica não deve conseguir lê-la de volta, e quem a expõe não
  deve conseguir incrementá-la — são dois papéis, e um token para cada um é o
  que impede o caso de uso de ganhar acesso de leitura por acidente de
  injeção.
*/
export interface MetricsExposition {
  render(): string;
}

export const METRICS_EXPOSITION = 'METRICS_EXPOSITION';
