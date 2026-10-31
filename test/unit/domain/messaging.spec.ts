// Inbox, outbox e envelope de evento de integração.
import { describe, expect, it } from 'bun:test';

import { InboxMessage } from '../../../src/domain/messaging/inbox-message';
import { IntegrationEvent } from '../../../src/domain/messaging/integration-event';
import type { IntegrationEventProps } from '../../../src/domain/messaging/integration-event';
import { OutboxMessage } from '../../../src/domain/messaging/outbox-message';
import { InvariantViolationError } from '../../../src/domain/shared/invariant-violation-error';

const NOW = new Date('2026-10-29T12:00:00.000Z');

interface ProbeData {
  readonly walletId: string;
  readonly money: { readonly amount: string; readonly currency: string };
}

class ProbeEvent extends IntegrationEvent<ProbeData> {
  readonly eventType = 'ProbeHappened';
  readonly version = 3;

  /*
    Factory estática em vez de construtor público: é o padrão das subclasses
    concretas (`static from(...)`), e o construtor da base é `protected` —
    invocável de dentro da classe, inclusive de um método estático dela.
  */
  static from(props: IntegrationEventProps<ProbeData>): ProbeEvent {
    return new ProbeEvent(props);
  }
}

function probeEvent(
  overrides: Partial<IntegrationEventProps<ProbeData>> = {},
): ProbeEvent {
  return ProbeEvent.from({
    eventId: 'event-1',
    aggregateId: 'wallet-1',
    correlationId: 'corr-1',
    occurredAt: NOW,
    data: {
      walletId: 'wallet-1',
      money: { amount: '25.00', currency: 'BRL' },
    },
    ...overrides,
  });
}

describe('IntegrationEvent', () => {
  it('serializa o envelope com eventType e version vindos do tipo', () => {
    expect(probeEvent().toJSON()).toEqual({
      eventId: 'event-1',
      eventType: 'ProbeHappened',
      aggregateId: 'wallet-1',
      correlationId: 'corr-1',
      causationId: undefined,
      occurredAt: '2026-10-29T12:00:00.000Z',
      version: 3,
      data: {
        walletId: 'wallet-1',
        money: { amount: '25.00', currency: 'BRL' },
      },
    });
  });

  it('serializa occurredAt em ISO-8601', () => {
    expect(probeEvent().toJSON().occurredAt).toBe('2026-10-29T12:00:00.000Z');
  });

  it('carrega causationId quando informado', () => {
    expect(probeEvent({ causationId: 'cause-1' }).toJSON().causationId).toBe(
      'cause-1',
    );
  });

  it('omite causationId do JSON quando ausente', () => {
    /*
      `JSON.stringify` descarta chave com valor undefined, então o payload
      gravado na outbox não carrega a chave vazia.
    */
    expect(JSON.stringify(probeEvent().toJSON())).not.toContain('causationId');
  });

  it('carrega dinheiro como string decimal, nunca instância de Money', () => {
    expect(probeEvent().toJSON().data.money.amount).toBe('25.00');
  });
});

describe('InboxMessage', () => {
  function received(): InboxMessage {
    return InboxMessage.receive({
      messageId: 'msg-123',
      consumerName: 'wager-consumer',
      payloadHash: 'a'.repeat(64),
      receivedAt: NOW,
    });
  }

  it('nasce não processada', () => {
    const inbox = received();
    expect(inbox.isProcessed()).toBe(false);
    expect(inbox.processedAt).toBeUndefined();
  });

  it('marca como processada', () => {
    const inbox = received();
    inbox.markProcessed(NOW);

    expect(inbox.isProcessed()).toBe(true);
    expect(inbox.processedAt).toBe(NOW);
  });

  it('recusa marcar duas vezes', () => {
    const inbox = received();
    inbox.markProcessed(NOW);

    expect(() => {
      inbox.markProcessed(NOW);
    }).toThrow(InvariantViolationError);
  });

  it('reidrata preservando o processamento', () => {
    const inbox = InboxMessage.rehydrate({
      messageId: 'msg-123',
      consumerName: 'wager-consumer',
      payloadHash: 'a'.repeat(64),
      receivedAt: NOW,
      processedAt: NOW,
    });

    expect(inbox.isProcessed()).toBe(true);
  });
});

describe('OutboxMessage — enfileiramento', () => {
  it('usa o eventId como chave primária da linha', () => {
    /*
      Reaproveitar o identificador torna o enfileiramento idempotente de
      graça: refazer a mesma operação não cria duas linhas.
    */
    const outbox = OutboxMessage.enqueue(probeEvent());

    expect(outbox.id).toBe('event-1');
    expect(outbox.aggregateId).toBe('wallet-1');
    expect(outbox.eventType).toBe('ProbeHappened');
  });

  it('guarda o envelope serializado como payload', () => {
    const outbox = OutboxMessage.enqueue(probeEvent());

    expect(outbox.payload).toEqual(probeEvent().toJSON());
  });

  it('nasce pendente, sem tentativas e vencida', () => {
    const outbox = OutboxMessage.enqueue(probeEvent());

    expect(outbox.isPending()).toBe(true);
    expect(outbox.attempts).toBe(0);
    expect(outbox.publishedAt).toBeUndefined();
    expect(outbox.isDue(NOW)).toBe(true);
  });
});

describe('OutboxMessage — publicação', () => {
  it('deixa de estar pendente ao ser publicada', () => {
    const outbox = OutboxMessage.enqueue(probeEvent());
    outbox.markPublished(NOW);

    expect(outbox.isPending()).toBe(false);
    expect(outbox.isDue(NOW)).toBe(false);
    expect(outbox.publishedAt).toBe(NOW);
  });

  it('recusa marcar publicação duas vezes', () => {
    const outbox = OutboxMessage.enqueue(probeEvent());
    outbox.markPublished(NOW);

    expect(() => {
      outbox.markPublished(NOW);
    }).toThrow(InvariantViolationError);
  });

  it('recusa reagendar o que já foi publicado', () => {
    const outbox = OutboxMessage.enqueue(probeEvent());
    outbox.markPublished(NOW);

    expect(() => {
      outbox.scheduleRetry(NOW);
    }).toThrow(InvariantViolationError);
  });
});

describe('OutboxMessage — backoff', () => {
  it('adia a primeira retentativa em 1 s', () => {
    const outbox = OutboxMessage.enqueue(probeEvent());
    outbox.scheduleRetry(NOW);

    expect(outbox.attempts).toBe(1);
    expect(outbox.nextAttemptAt?.getTime()).toBe(NOW.getTime() + 1_000);
  });

  it('dobra a espera a cada tentativa', () => {
    const outbox = OutboxMessage.enqueue(probeEvent());
    const expected = [1_000, 2_000, 4_000, 8_000, 16_000];

    for (const delay of expected) {
      outbox.scheduleRetry(NOW);
      expect(outbox.nextAttemptAt?.getTime()).toBe(NOW.getTime() + delay);
    }
  });

  it('limita a espera a 5 min', () => {
    const outbox = OutboxMessage.enqueue(probeEvent());
    for (let attempt = 0; attempt < 20; attempt += 1) {
      outbox.scheduleRetry(NOW);
    }

    expect(outbox.nextAttemptAt?.getTime()).toBe(NOW.getTime() + 300_000);
  });

  it('não vence antes da hora marcada', () => {
    const outbox = OutboxMessage.enqueue(probeEvent());
    outbox.scheduleRetry(NOW);

    expect(outbox.isDue(new Date(NOW.getTime() + 999))).toBe(false);
    expect(outbox.isDue(new Date(NOW.getTime() + 1_000))).toBe(true);
  });

  it('continua pendente indefinidamente, sem limite de tentativas', () => {
    /*
      Publicação duplicada é segura para o consumidor; perder evento
      confirmado não é aceitável em nenhuma circunstância. Então o evento
      nunca é descartado — ele aparece na métrica de outbox lag.
    */
    const outbox = OutboxMessage.enqueue(probeEvent());
    for (let attempt = 0; attempt < 100; attempt += 1) {
      outbox.scheduleRetry(NOW);
    }

    expect(outbox.isPending()).toBe(true);
    expect(outbox.attempts).toBe(100);
  });
});
