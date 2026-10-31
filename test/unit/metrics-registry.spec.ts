import { describe, expect, it } from 'bun:test';

import {
  LATENCY_BUCKETS_SECONDS,
  METRICS_CATALOG,
  Metric,
  MetricKind,
} from '../../src/application/ports/metrics.port';
import type { MetricLabels } from '../../src/application/ports/metrics.port';
import { InMemoryMetricsRegistry } from '../../src/infrastructure/observability/metrics.registry';

/*
  Teste de unidade puro: o registry não tem E/S nenhuma. Nenhum dublê
  envolvido — o objeto sob teste é o de produção.
*/

// As amostras de uma métrica no texto, sem as linhas de HELP e TYPE.
function samplesOf(text: string, name: string): string[] {
  return text
    .split('\n')
    .filter((line) => line.startsWith(name) && !line.startsWith('#'));
}

function valueOf(text: string, line: string): number {
  const found = text.split('\n').find((candidate) => candidate === line);
  if (found === undefined) {
    throw new Error(`amostra não encontrada: ${line}`);
  }
  return Number(found.split(' ').at(-1));
}

describe('contadores', () => {
  it('incrementa de um por padrão', () => {
    const metrics = new InMemoryMetricsRegistry();

    metrics.increment(Metric.DuplicatesTotal, { guard: 'inbox' });
    metrics.increment(Metric.DuplicatesTotal, { guard: 'inbox' });

    expect(
      valueOf(
        metrics.render(),
        'wagering_duplicates_detected_total{guard="inbox"} 2',
      ),
    ).toBe(2);
  });

  it('aceita incremento explícito', () => {
    const metrics = new InMemoryMetricsRegistry();

    metrics.increment(Metric.RetriesTotal, { subject: 'outbox' }, 5);

    expect(metrics.render()).toContain(
      'wagering_retries_total{subject="outbox"} 5',
    );
  });

  it('separa séries por rótulo', () => {
    const metrics = new InMemoryMetricsRegistry();

    metrics.increment(Metric.DuplicatesTotal, { guard: 'inbox' });
    metrics.increment(Metric.DuplicatesTotal, { guard: 'idempotency' });

    const samples = samplesOf(
      metrics.render(),
      'wagering_duplicates_detected_total',
    );
    expect(samples).toHaveLength(2);
    expect(samples).toContain(
      'wagering_duplicates_detected_total{guard="inbox"} 1',
    );
    expect(samples).toContain(
      'wagering_duplicates_detected_total{guard="idempotency"} 1',
    );
  });

  it('ordena os rótulos, de modo que a ordem da chamada não crie série nova', () => {
    const metrics = new InMemoryMetricsRegistry();

    metrics.increment(Metric.TransactionsTotal, {
      status: 'PROCESSED',
      kind: 'BET',
      source: 'http',
    });
    metrics.increment(Metric.TransactionsTotal, {
      source: 'http',
      kind: 'BET',
      status: 'PROCESSED',
    });

    expect(
      samplesOf(metrics.render(), 'wagering_transactions_total'),
    ).toHaveLength(1);
    expect(metrics.render()).toContain(
      'wagering_transactions_total' +
        '{kind="BET",source="http",status="PROCESSED"} 2',
    );
  });

  it('ignora rótulo com valor indefinido em vez de criar série separada', () => {
    const metrics = new InMemoryMetricsRegistry();

    // `undefined` é aceito pelo tipo e descartado: é o que chega quando o
    // rótulo vem de um campo opcional do domínio. Sem o descarte, viraria a
    // string literal "undefined" e abriria uma série paralela.
    const labels: MetricLabels = { subject: 'reference', extra: undefined };

    metrics.increment(Metric.RetriesTotal, labels);

    expect(metrics.render()).toContain(
      'wagering_retries_total{subject="reference"} 1',
    );
  });
});

describe('gauges', () => {
  it('substitui o valor em vez de acumular', () => {
    const metrics = new InMemoryMetricsRegistry();

    metrics.gauge(Metric.OutboxPendingAgeSeconds, 12);
    metrics.gauge(Metric.OutboxPendingAgeSeconds, 3);

    expect(metrics.render()).toContain('wagering_outbox_pending_age_seconds 3');
  });

  it('aceita zero, que é informação e não ausência', () => {
    const metrics = new InMemoryMetricsRegistry();

    metrics.gauge(Metric.OutboxPendingCount, 0);

    expect(metrics.render()).toContain('wagering_outbox_pending_count 0');
  });
});

describe('histogramas', () => {
  it('acumula os buckets, como o formato exige', () => {
    const metrics = new InMemoryMetricsRegistry();
    const labels = { operation: 'submit', outcome: 'processed' };

    metrics.observe(Metric.ProcessingDurationSeconds, 0.003, labels);
    metrics.observe(Metric.ProcessingDurationSeconds, 0.02, labels);

    const text = metrics.render();
    const suffix = '{operation="submit",outcome="processed"';

    // 0.003 cai em le=0.005; 0.02 cai em le=0.025. O bucket é cumulativo.
    expect(text).toContain(
      `wagering_processing_duration_seconds_bucket${suffix},le="0.001"} 0`,
    );
    expect(text).toContain(
      `wagering_processing_duration_seconds_bucket${suffix},le="0.005"} 1`,
    );
    expect(text).toContain(
      `wagering_processing_duration_seconds_bucket${suffix},le="0.025"} 2`,
    );
    expect(text).toContain(
      `wagering_processing_duration_seconds_bucket${suffix},le="+Inf"} 2`,
    );
  });

  it('conta e soma as observações', () => {
    const metrics = new InMemoryMetricsRegistry();
    const labels = { operation: 'consume', outcome: 'duplicate' };

    metrics.observe(Metric.ProcessingDurationSeconds, 0.1, labels);
    metrics.observe(Metric.ProcessingDurationSeconds, 0.2, labels);

    const text = metrics.render();
    const suffix = '{operation="consume",outcome="duplicate"}';

    expect(text).toContain(
      `wagering_processing_duration_seconds_count${suffix} 2`,
    );
    expect(text).toContain(
      `wagering_processing_duration_seconds_sum${suffix} 0.3`,
    );
  });

  it('manda o que passa do último bucket para o +Inf', () => {
    const metrics = new InMemoryMetricsRegistry();
    const labels = { operation: 'submit', outcome: 'processed' };
    const last = LATENCY_BUCKETS_SECONDS.at(-1) ?? 0;

    metrics.observe(Metric.ProcessingDurationSeconds, last + 1, labels);

    const text = metrics.render();
    const suffix = '{operation="submit",outcome="processed"';

    expect(text).toContain(
      `wagering_processing_duration_seconds_bucket${suffix},` +
        `le="${String(last)}"} 0`,
    );
    expect(text).toContain(
      `wagering_processing_duration_seconds_bucket${suffix},le="+Inf"} 1`,
    );
  });

  it('inclui o valor exatamente no limite no bucket do limite', () => {
    const metrics = new InMemoryMetricsRegistry();
    const labels = { operation: 'submit', outcome: 'processed' };

    // `le` quer dizer "menor ou igual". Um valor exatamente igual ao limite
    // caindo no bucket seguinte é o erro clássico desta estrutura.
    metrics.observe(Metric.ProcessingDurationSeconds, 0.001, labels);

    expect(metrics.render()).toContain(
      'wagering_processing_duration_seconds_bucket' +
        '{operation="submit",outcome="processed",le="0.001"} 1',
    );
  });
});

describe('exposição', () => {
  it('declara HELP e TYPE para toda métrica do catálogo', () => {
    const text = new InMemoryMetricsRegistry().render();

    for (const declaration of METRICS_CATALOG) {
      expect(text).toContain(`# HELP ${declaration.name} `);
      expect(text).toContain(`# TYPE ${declaration.name} ${declaration.kind}`);
    }
  });

  it('expõe toda métrica em zero antes da primeira observação', () => {
    // É o que distingue "não aconteceu" de "não está instrumentado". Série
    // que só nasce no primeiro evento deixa essa dúvida no gráfico.
    const text = new InMemoryMetricsRegistry().render();

    for (const declaration of METRICS_CATALOG) {
      if (declaration.kind === MetricKind.Histogram) {
        expect(text).toContain(`${declaration.name}_count 0`);
        expect(text).toContain(`${declaration.name}_sum 0`);
        expect(text).toContain(`${declaration.name}_bucket{le="+Inf"} 0`);
      } else {
        expect(samplesOf(text, declaration.name)).toContain(
          `${declaration.name} 0`,
        );
      }
    }
  });

  it('declara as métricas de operação que o sistema precisa expor', () => {
    const names = METRICS_CATALOG.map((declaration) => declaration.name);

    expect(names).toContain(Metric.TransactionsTotal);
    expect(names).toContain(Metric.DuplicatesTotal);
    expect(names).toContain(Metric.RetriesTotal);
    expect(names).toContain(Metric.DlqMessagesTotal);
    expect(names).toContain(Metric.LockConflictsTotal);
    expect(names).toContain(Metric.OutboxPendingAgeSeconds);
    expect(names).toContain(Metric.ProcessingDurationSeconds);
    // Divergência de reconciliação também é contabilizada em métrica.
    expect(names).toContain(Metric.ReconciliationChecksTotal);
  });

  it('termina com quebra de linha', () => {
    expect(new InMemoryMetricsRegistry().render().endsWith('\n')).toBe(true);
  });

  it('escapa aspas e barras no valor do rótulo', () => {
    const metrics = new InMemoryMetricsRegistry();

    metrics.increment(Metric.DlqMessagesTotal, { reason: 'a"b\\c' });

    expect(metrics.render()).toContain(
      'wagering_dlq_messages_total{reason="a\\"b\\\\c"} 1',
    );
  });

  it('não usa notação científica, que o formato não aceita', () => {
    const metrics = new InMemoryMetricsRegistry();

    metrics.gauge(Metric.OutboxPendingAgeSeconds, 0.0000001);

    expect(metrics.render()).not.toContain('e-');
  });
});

describe('erros de programação', () => {
  it('lança em rótulo fora do catálogo', () => {
    const metrics = new InMemoryMetricsRegistry();

    // Gravar criaria série paralela que ninguém soma; ignorar produziria um
    // painel que parece certo e está errado. As duas são piores que lançar.
    expect(() => {
      metrics.increment(Metric.DuplicatesTotal, { wallet: 'abc' });
    }).toThrow(/wallet/);
  });

  it('lança ao usar contador como gauge', () => {
    const metrics = new InMemoryMetricsRegistry();

    expect(() => {
      metrics.gauge(Metric.DuplicatesTotal, 1);
    }).toThrow(/counter/);
  });

  it('lança ao usar gauge como histograma', () => {
    const metrics = new InMemoryMetricsRegistry();

    expect(() => {
      metrics.observe(Metric.OutboxPendingCount, 0.5);
    }).toThrow(/gauge/);
  });

  it('nomeia os rótulos aceitos na mensagem do erro', () => {
    const metrics = new InMemoryMetricsRegistry();

    expect(() => {
      metrics.increment(Metric.TransactionsTotal, { errado: 'x' });
    }).toThrow(/kind, status, source/);
  });
});
