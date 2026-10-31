import {
  LATENCY_BUCKETS_SECONDS,
  METRICS_CATALOG,
  MetricKind,
} from '../../application/ports/metrics.port';
import type {
  Metric,
  MetricDeclaration,
  MetricLabels,
  MetricsExposition,
  MetricsPort,
} from '../../application/ports/metrics.port';
import { InvariantViolationError } from '../../domain/shared/invariant-violation-error';

/*
  Registry de métricas em processo, serializável em texto Prometheus.

  Por que caseiro e não `prom-client`: o domínio só precisa de contador,
  gauge e histograma de latência, e o formato de texto do Prometheus é
  estável e curto o bastante para não valer uma dependência de runtime num
  projeto cuja política declarada é não instalar biblioteca que não vai ser
  usada de verdade. Ver ADR-014.

  **Métrica é por processo, e isso é correto.** O sistema roda com três ou
  mais instâncias, e cada uma expõe o seu próprio `/metrics` — agregar é
  trabalho do coletor, que é quem sabe quantas instâncias existem.
  As contagens que precisam ser globais não moram aqui: `outbox lag` é lido
  do banco a cada passada do worker, e por isso é gauge e não contador.
*/
export class InMemoryMetricsRegistry implements MetricsPort, MetricsExposition {
  private readonly declarations = new Map<string, MetricDeclaration>(
    METRICS_CATALOG.map((declaration) => [declaration.name, declaration]),
  );

  private readonly scalars = new Map<string, Map<string, number>>();
  private readonly histograms = new Map<string, Map<string, Histogram>>();

  constructor() {
    /*
      Toda série declarada nasce com a sua amostra sem rótulo, para que o
      endpoint responda com a métrica em zero antes do primeiro evento. Ver
      a razão no cabeçalho do catálogo.
    */
    for (const declaration of METRICS_CATALOG) {
      if (declaration.kind === MetricKind.Histogram) {
        this.histograms.set(declaration.name, new Map());
      } else {
        this.scalars.set(declaration.name, new Map());
      }
    }
  }

  increment(name: Metric, labels?: MetricLabels, by = 1): void {
    const key = this.sampleKey(name, MetricKind.Counter, labels);
    const series = this.series(this.scalars, name);
    series.set(key, (series.get(key) ?? 0) + by);
  }

  gauge(name: Metric, value: number, labels?: MetricLabels): void {
    const key = this.sampleKey(name, MetricKind.Gauge, labels);
    this.series(this.scalars, name).set(key, value);
  }

  observe(name: Metric, seconds: number, labels?: MetricLabels): void {
    const key = this.sampleKey(name, MetricKind.Histogram, labels);
    const series = this.series(this.histograms, name);

    let histogram = series.get(key);
    if (histogram === undefined) {
      histogram = {
        counts: new Array<number>(LATENCY_BUCKETS_SECONDS.length + 1).fill(0),
        sum: 0,
        count: 0,
      };
      series.set(key, histogram);
    }

    histogram.sum += seconds;
    histogram.count += 1;

    /*
      O último índice é o `+Inf`, e ele recebe o que passou de todos os
      buckets. Buscar linearmente é mais rápido que binária nesta escala.
    */
    const bucket = LATENCY_BUCKETS_SECONDS.findIndex(
      (boundary) => seconds <= boundary,
    );
    const slot = bucket === -1 ? LATENCY_BUCKETS_SECONDS.length : bucket;
    histogram.counts[slot] = (histogram.counts[slot] ?? 0) + 1;
  }

  // Formato de exposição do Prometheus, versão texto.
  render(): string {
    const lines: string[] = [];

    for (const declaration of METRICS_CATALOG) {
      lines.push(`# HELP ${declaration.name} ${declaration.help}`);
      lines.push(`# TYPE ${declaration.name} ${declaration.kind}`);

      if (declaration.kind === MetricKind.Histogram) {
        this.writeHistogram(lines, declaration.name);
      } else {
        this.writeScalar(lines, declaration.name);
      }
    }

    /*
      O formato exige linha em branco no fim; sem ela, alguns coletores
      descartam a última amostra.
    */
    return `${lines.join('\n')}\n`;
  }

  private writeScalar(lines: string[], name: string): void {
    const series = this.series(this.scalars, name);

    if (series.size === 0) {
      lines.push(`${name} 0`);
      return;
    }

    for (const [key, value] of [...series].sort(byKey)) {
      lines.push(`${name}${key} ${formatNumber(value)}`);
    }
  }

  private writeHistogram(lines: string[], name: string): void {
    const series = this.series(this.histograms, name);

    if (series.size === 0) {
      for (const boundary of LATENCY_BUCKETS_SECONDS) {
        lines.push(`${name}_bucket{le="${formatNumber(boundary)}"} 0`);
      }
      lines.push(`${name}_bucket{le="+Inf"} 0`);
      lines.push(`${name}_sum 0`);
      lines.push(`${name}_count 0`);
      return;
    }

    for (const [key, histogram] of [...series].sort(byKey)) {
      let cumulative = 0;

      LATENCY_BUCKETS_SECONDS.forEach((boundary, index) => {
        cumulative += histogram.counts[index] ?? 0;
        lines.push(
          `${name}_bucket${withLabel(key, 'le', formatNumber(boundary))} ` +
            String(cumulative),
        );
      });

      lines.push(
        `${name}_bucket${withLabel(key, 'le', '+Inf')} ${String(
          histogram.count,
        )}`,
      );
      lines.push(`${name}_sum${key} ${formatNumber(histogram.sum)}`);
      lines.push(`${name}_count${key} ${String(histogram.count)}`);
    }
  }

  private series<T>(
    store: Map<string, Map<string, T>>,
    name: string,
  ): Map<string, T> {
    const series = store.get(name);
    if (series === undefined) {
      throw new InvariantViolationError(
        `a métrica ${name} não está declarada com o tipo esperado`,
      );
    }
    return series;
  }

  /*
    Valida e serializa os rótulos.

    Rótulo fora do catálogo **lança**, em vez de ser gravado ou ignorado em
    silêncio. As duas alternativas são piores: gravar cria série paralela que
    ninguém soma, e ignorar produz um painel que parece certo e está errado —
    exatamente o que a métrica existe para evitar. Como é erro de
    programação, aparece na primeira execução do teste que cobre o caminho, e
    não em produção.
  */
  private sampleKey(
    name: Metric,
    kind: MetricKind,
    labels: MetricLabels | undefined,
  ): string {
    const declaration = this.declarations.get(name);

    if (declaration === undefined) {
      throw new InvariantViolationError(`métrica não declarada: ${name}`);
    }
    if (declaration.kind !== kind) {
      throw new InvariantViolationError(
        `a métrica ${name} é ${declaration.kind}, e foi usada como ${kind}`,
      );
    }

    /*
      Predicado de tipo porque `filter` não estreita sozinho, e o que sai
      daqui é usado como `string` na serialização.
    */
    const entries = Object.entries(labels ?? {}).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    );

    for (const [label] of entries) {
      if (!declaration.labels.includes(label)) {
        throw new InvariantViolationError(
          `rótulo ${label} não declarado para a métrica ${name}; ` +
            `declarados: ${declaration.labels.join(', ') || '(nenhum)'}`,
        );
      }
    }

    if (entries.length === 0) {
      return '';
    }

    const pairs = entries
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([label, value]) => `${label}="${escapeLabelValue(value)}"`)
      .join(',');

    return `{${pairs}}`;
  }
}

interface Histogram {
  readonly counts: number[];
  sum: number;
  count: number;
}

function byKey(
  [left]: readonly [string, unknown],
  [right]: readonly [string, unknown],
): number {
  return left.localeCompare(right);
}

// Insere um rótulo numa chave já serializada, preservando a ordem.
function withLabel(key: string, label: string, value: string): string {
  const pair = `${label}="${value}"`;
  return key === '' ? `{${pair}}` : `${key.slice(0, -1)},${pair}}`;
}

function escapeLabelValue(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n');
}

/*
  O formato não aceita notação científica, e `String(1e-7)` a produz. Também
  não aceita `Infinity` escrito por extenso em valor de amostra.
*/
function formatNumber(value: number): string {
  if (!Number.isFinite(value)) {
    return value > 0 ? '+Inf' : '-Inf';
  }
  if (Number.isInteger(value)) {
    return String(value);
  }
  return value.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
}
