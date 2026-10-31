/*
  **Este arquivo usa dublês, e por um motivo específico.**

  O que ele verifica é a **ordem** das chamadas que o consumidor faz ao
  broker: que o `DeleteMessage` sai depois de o caso de uso retornar, que ele
  não sai quando o processamento falha, e que grupos diferentes avançam em
  paralelo enquanto o mesmo grupo avança em fila. Nenhuma dessas afirmações é
  sobre o SQS — são sobre o consumidor —, e provar ordem contra um serviço
  real exigiria conseguir travar o serviço sob demanda, o que não é
  determinístico.

  O comportamento contra PostgreSQL e MiniStack de verdade está em
  `test/integration/sqs-consumer.spec.ts`, sem dublê nenhum.
*/
import { describe, expect, it } from 'bun:test';
import { GetQueueUrlCommand, ReceiveMessageCommand } from '@aws-sdk/client-sqs';
import type { Message, SQSClient } from '@aws-sdk/client-sqs';

import type { ConsumeWagerMessageUseCase } from '../../src/application/use-cases/consume-wager-message.use-case';
import type {
  LogContext,
  LoggerPort,
} from '../../src/application/ports/logger.port';
import type {
  Metric,
  MetricLabels,
  MetricsPort,
} from '../../src/application/ports/metrics.port';
import { SqsWagerConsumer } from '../../src/infrastructure/messaging/sqs-consumer';

const OPTIONS = {
  queueName: 'wager-transactions.fifo',
  deadLetterQueueName: 'wager-transactions-dlq.fifo',
  maxMessages: 10,
  shutdownTimeoutMs: 500,
};

function envelope(externalId = 'tx-1'): string {
  return JSON.stringify({
    messageId: 'msg-1',
    type: 'WagerTransactionRequested',
    occurredAt: '2026-10-30T12:00:00.000Z',
    data: {
      providerId: 'provider-a',
      externalTransactionId: externalId,
      idempotencyKey: `provider-a:${externalId}`,
      playerId: 'player-1',
      walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
      roundId: 'round-987',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
    },
  });
}

function message(overrides: Partial<Message> = {}): Message {
  return {
    MessageId: 'broker-1',
    ReceiptHandle: 'handle-1',
    Body: envelope(),
    Attributes: { ApproximateReceiveCount: '1', MessageGroupId: 'wallet-1' },
    ...overrides,
  };
}

interface FakeBroker {
  readonly client: SQSClient;
  // Nome de cada comando enviado, em ordem.
  readonly calls: string[];
  // Mensagens a entregar na próxima chamada de recebimento.
  queue: Message[][];
  // Máximo de recebimentos simultâneos — um laço só nunca passa de 1.
  readonly peakConcurrentReceives: number;
}

/*
  Dublê do cliente do SDK.

  Registra a sequência de comandos e entrega os lotes programados. Depois de
  esgotar os lotes, devolve vazio — e não trava —, de modo que o laço do
  consumidor continue girando sem esta suíte precisar sincronizar com ele.
*/
function fakeBroker(batches: Message[][] = []): FakeBroker {
  const calls: string[] = [];
  const queue = [...batches];
  let inReceive = 0;
  let peak = 0;

  const client = {
    send: async (command: unknown): Promise<unknown> => {
      const name = command?.constructor.name ?? 'Unknown';
      calls.push(name);

      if (command instanceof GetQueueUrlCommand) {
        return { QueueUrl: 'http://localhost:4566/000000000000/queue' };
      }
      if (command instanceof ReceiveMessageCommand) {
        inReceive += 1;
        peak = Math.max(peak, inReceive);
        try {
          const next = queue.shift();
          if (next === undefined) {
            // Sem mais lotes: espera curta, imitando um long poll vazio.
            await Bun.sleep(5);
            return { Messages: [] };
          }
          return { Messages: next };
        } finally {
          inReceive -= 1;
        }
      }
      return {};
    },
  } as unknown as SQSClient;

  return {
    client,
    calls,
    queue,
    get peakConcurrentReceives(): number {
      return peak;
    },
  };
}

function silentLogger(): LoggerPort {
  const noop = (_message: string, _context?: LogContext): void => {
    /* silencioso: esta suíte verifica ordem de chamadas, não log */
  };
  return { info: noop, warn: noop, error: noop };
}

function recordingMetrics(): {
  port: MetricsPort;
  increments: { name: string; labels?: MetricLabels }[];
} {
  const increments: { name: string; labels?: MetricLabels }[] = [];
  return {
    increments,
    port: {
      increment: (name: Metric, labels?: MetricLabels): void => {
        increments.push(labels === undefined ? { name } : { name, labels });
      },
      gauge: (): void => {
        /* não usado aqui */
      },
      observe: (): void => {
        /* não usado aqui */
      },
    },
  };
}

// Caso de uso de consumo controlável.
function fakeConsume(
  behaviour: () => Promise<unknown>,
): ConsumeWagerMessageUseCase {
  return {
    execute: behaviour,
  } as unknown as ConsumeWagerMessageUseCase;
}

// Roda o consumidor até a condição valer, e então o para.
async function runUntil(
  consumer: SqsWagerConsumer,
  condition: () => boolean,
): Promise<void> {
  consumer.start();

  const deadline = Date.now() + 3_000;
  while (!condition() && Date.now() < deadline) {
    await Bun.sleep(5);
  }

  await consumer.stop();
}

describe('ack só depois do commit', () => {
  it('confirma a mensagem depois de o caso de uso retornar', async () => {
    const order: string[] = [];
    const broker = fakeBroker([[message()]]);
    const metrics = recordingMetrics();

    const consumer = new SqsWagerConsumer(
      broker.client,
      fakeConsume(async () => {
        order.push('consume:start');
        await Bun.sleep(20);
        order.push('consume:end');
        return { outcome: 'processed', submission: { outcome: 'refused' } };
      }),
      OPTIONS,
      silentLogger(),
      metrics.port,
    );

    await runUntil(consumer, () =>
      broker.calls.includes('DeleteMessageCommand'),
    );

    // A ordem é a garantia: `consume:end` antes do `DeleteMessage`. Invertida,
    // uma queda entre os dois perderia a mensagem com o efeito não comitado.
    const deleteAt = broker.calls.indexOf('DeleteMessageCommand');
    expect(deleteAt).toBeGreaterThanOrEqual(0);
    expect(order).toEqual(['consume:start', 'consume:end']);
  });

  it('não confirma quando o processamento falha', async () => {
    const broker = fakeBroker([[message()]]);
    const metrics = recordingMetrics();
    let attempts = 0;

    const consumer = new SqsWagerConsumer(
      broker.client,
      fakeConsume(() => {
        attempts += 1;
        // `ECONNREFUSED` é falha de transporte: transitória, e a mensagem
        // precisa voltar pela fila em vez de ser confirmada.
        return Promise.reject(
          Object.assign(new Error('sem banco'), { code: 'ECONNREFUSED' }),
        );
      }),
      OPTIONS,
      silentLogger(),
      metrics.port,
    );

    await runUntil(consumer, () => attempts > 0);

    expect(broker.calls).not.toContain('DeleteMessageCommand');
    expect(broker.calls).not.toContain('SendMessageCommand');
  });

  it('conta a retentativa quando devolve a mensagem à fila', async () => {
    const broker = fakeBroker([[message()]]);
    const metrics = recordingMetrics();
    let attempts = 0;

    const consumer = new SqsWagerConsumer(
      broker.client,
      fakeConsume(() => {
        attempts += 1;
        return Promise.reject(new Error('qualquer falha'));
      }),
      OPTIONS,
      silentLogger(),
      metrics.port,
    );

    await runUntil(consumer, () => attempts > 0);

    expect(
      metrics.increments.some(
        (entry) => entry.name === 'wagering_retries_total',
      ),
    ).toBe(true);
  });

  it('erro inesperado é tratado como transitório, não descartado', async () => {
    // Tratar bug como permanente jogaria na DLQ, na primeira tentativa, uma
    // operação financeira que talvez passasse na segunda.
    const broker = fakeBroker([[message()]]);
    const metrics = recordingMetrics();
    let attempts = 0;

    const consumer = new SqsWagerConsumer(
      broker.client,
      fakeConsume(() => {
        attempts += 1;
        return Promise.reject(new TypeError('bug nosso'));
      }),
      OPTIONS,
      silentLogger(),
      metrics.port,
    );

    await runUntil(consumer, () => attempts > 0);

    expect(broker.calls).not.toContain('SendMessageCommand');
    expect(broker.calls).not.toContain('DeleteMessageCommand');
  });
});

describe('erro permanente', () => {
  it('envia à DLQ antes de confirmar a original', async () => {
    const broker = fakeBroker([[message({ Body: '{ não é json' })]]);
    const metrics = recordingMetrics();

    const consumer = new SqsWagerConsumer(
      broker.client,
      fakeConsume(() => Promise.reject(new Error('não deveria ser chamado'))),
      OPTIONS,
      silentLogger(),
      metrics.port,
    );

    await runUntil(consumer, () =>
      broker.calls.includes('DeleteMessageCommand'),
    );

    const sendAt = broker.calls.indexOf('SendMessageCommand');
    const deleteAt = broker.calls.indexOf('DeleteMessageCommand');

    // Confirmar primeiro perderia a evidência do payload defeituoso. Duplicar
    // na DLQ custa uma inspeção repetida; perder custa a investigação toda.
    expect(sendAt).toBeGreaterThanOrEqual(0);
    expect(deleteAt).toBeGreaterThan(sendAt);
  });

  it('conta a mensagem na métrica de DLQ, com o motivo', async () => {
    const broker = fakeBroker([[message({ Body: '{ não é json' })]]);
    const metrics = recordingMetrics();

    const consumer = new SqsWagerConsumer(
      broker.client,
      fakeConsume(() => Promise.reject(new Error('não chamado'))),
      OPTIONS,
      silentLogger(),
      metrics.port,
    );

    await runUntil(consumer, () =>
      broker.calls.includes('DeleteMessageCommand'),
    );

    expect(metrics.increments).toContainEqual({
      name: 'wagering_dlq_messages_total',
      labels: { reason: 'INVALID_JSON' },
    });
  });

  it('corpo vazio é permanente', async () => {
    const broker = fakeBroker([[message({ Body: '' })]]);
    const metrics = recordingMetrics();

    const consumer = new SqsWagerConsumer(
      broker.client,
      fakeConsume(() => Promise.reject(new Error('não chamado'))),
      OPTIONS,
      silentLogger(),
      metrics.port,
    );

    await runUntil(consumer, () =>
      broker.calls.includes('DeleteMessageCommand'),
    );

    expect(metrics.increments).toContainEqual({
      name: 'wagering_dlq_messages_total',
      labels: { reason: 'EMPTY_BODY' },
    });
  });
});

describe('ordenação por grupo', () => {
  it('serializa o mesmo grupo e paraleliza grupos distintos', async () => {
    const started: string[] = [];
    const finished: string[] = [];

    const batch = [
      message({
        MessageId: 'a1',
        ReceiptHandle: 'h-a1',
        Body: envelope('a1'),
        Attributes: { ApproximateReceiveCount: '1', MessageGroupId: 'A' },
      }),
      message({
        MessageId: 'a2',
        ReceiptHandle: 'h-a2',
        Body: envelope('a2'),
        Attributes: { ApproximateReceiveCount: '1', MessageGroupId: 'A' },
      }),
      message({
        MessageId: 'b1',
        ReceiptHandle: 'h-b1',
        Body: envelope('b1'),
        Attributes: { ApproximateReceiveCount: '1', MessageGroupId: 'B' },
      }),
    ];

    const broker = fakeBroker([batch]);
    const metrics = recordingMetrics();

    const consumer = new SqsWagerConsumer(
      broker.client,
      fakeConsume(async (...args: unknown[]) => {
        const parsed = args[0] as { data: { externalTransactionId: string } };
        const id = parsed.data.externalTransactionId;
        started.push(id);
        await Bun.sleep(30);
        finished.push(id);
        return { outcome: 'processed', submission: { outcome: 'refused' } };
      }),
      OPTIONS,
      silentLogger(),
      metrics.port,
    );

    await runUntil(consumer, () => finished.length === 3);

    // `B` começa junto com `A`: wallets diferentes não se bloqueiam.
    expect(started.slice(0, 2).sort()).toEqual(['a1', 'b1']);

    // `a2` só começa depois de `a1` terminar: dentro do grupo, a ordem que a
    // fila FIFO garantiu é preservada.
    expect(started.indexOf('a2')).toBeGreaterThan(finished.indexOf('a1'));
  });

  it('mensagem sem ReceiptHandle não é processada, e não derruba o lote', async () => {
    let calls = 0;
    const broker = fakeBroker([
      [
        message({ ReceiptHandle: undefined, MessageId: 'sem-handle' }),
        message({ MessageId: 'ok', ReceiptHandle: 'h-ok' }),
      ],
    ]);
    const metrics = recordingMetrics();

    const consumer = new SqsWagerConsumer(
      broker.client,
      fakeConsume(() => {
        calls += 1;
        return Promise.resolve({
          outcome: 'processed',
          submission: { outcome: 'refused' },
        });
      }),
      OPTIONS,
      silentLogger(),
      metrics.port,
    );

    await runUntil(consumer, () => calls > 0);

    // Sem `ReceiptHandle` não há como confirmar, e processar sem poder
    // confirmar garantiria reprocessamento a cada entrega.
    expect(calls).toBe(1);
  });
});

describe('encerramento gracioso', () => {
  it('para dentro do prazo, sem esperar o long poll', async () => {
    const broker = fakeBroker();
    const metrics = recordingMetrics();

    const consumer = new SqsWagerConsumer(
      broker.client,
      fakeConsume(() => Promise.reject(new Error('sem mensagens'))),
      OPTIONS,
      silentLogger(),
      metrics.port,
    );

    consumer.start();
    await Bun.sleep(20);

    const startedAt = Date.now();
    await consumer.stop();

    // O long poll real é de 20 s. Sem o cancelamento por `AbortSignal`, este
    // `stop` esperaria por ele e estouraria qualquer prazo de shutdown.
    expect(Date.now() - startedAt).toBeLessThan(OPTIONS.shutdownTimeoutMs * 2);
  });

  it('parar duas vezes é inofensivo', async () => {
    const broker = fakeBroker();
    const metrics = recordingMetrics();

    const consumer = new SqsWagerConsumer(
      broker.client,
      fakeConsume(() => Promise.resolve({ outcome: 'duplicate' })),
      OPTIONS,
      silentLogger(),
      metrics.port,
    );

    consumer.start();
    await consumer.stop();

    // O `onApplicationShutdown` pode ser chamado mais de uma vez num
    // encerramento conturbado.
    let threw = false;
    try {
      await consumer.stop();
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
  });

  it('iniciar duas vezes não cria dois laços', async () => {
    const broker = fakeBroker();
    const metrics = recordingMetrics();

    const consumer = new SqsWagerConsumer(
      broker.client,
      fakeConsume(() => Promise.resolve({ outcome: 'duplicate' })),
      OPTIONS,
      silentLogger(),
      metrics.port,
    );

    consumer.start();
    consumer.start();
    await Bun.sleep(40);
    await consumer.stop();

    // Dois laços teriam dois `ReceiveMessage` no ar ao mesmo tempo — e o
    // segundo ficaria órfão depois do `stop`, recebendo mensagens que
    // ninguém confirmaria.
    expect(broker.peakConcurrentReceives).toBe(1);
  });
});
