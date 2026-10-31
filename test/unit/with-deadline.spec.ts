/*
  Prazo máximo de uma operação de E/S.

  Teste de unidade puro: promessas e temporizadores, sem rede, sem banco e
  sem dublê de nada.

  As asserções sobre promessa estão na forma explícita, e não no idioma
  `.resolves` / `.rejects` dos matchers: eles são declarados como `void` no
  `bun:test`, e aguardá-los recai em `await-thenable` e
  `no-confusing-void-expression` — duas regras com informação de tipos que
  existem justamente para pegar promessa não aguardada.
*/
import { describe, expect, it } from 'bun:test';

import {
  ABORT_GRACE_MS,
  DeadlineExceededError,
  withDeadline,
} from '../../src/shared/with-deadline';

function resolveAfter<T>(ms: number, value: T): Promise<T> {
  return new Promise<T>((resolve) => {
    setTimeout(() => {
      resolve(value);
    }, ms);
  });
}

function rejectAfter(ms: number, error: Error): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    setTimeout(() => {
      reject(error);
    }, ms);
  });
}

// Nunca assenta — a dependência que aceita a conexão e não responde.
function never(): Promise<never> {
  return new Promise<never>(() => undefined);
}

// O erro de uma promessa que **deve** rejeitar.
async function rejectionOf(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
  } catch (error) {
    return error;
  }
  throw new Error('a promessa resolveu, e deveria ter rejeitado');
}

describe('withDeadline', () => {
  it('devolve o resultado quando a operação responde a tempo', async () => {
    expect(await withDeadline(resolveAfter(10, 'ok'), 200, 'sonda')).toBe('ok');
  });

  it('rejeita quando a operação nunca responde', async () => {
    expect(
      await rejectionOf(withDeadline(never(), 50, 'sonda')),
    ).toBeInstanceOf(DeadlineExceededError);
  });

  it('responde dentro do prazo, e não depois dele', async () => {
    // É a garantia que o endpoint de readiness compra: a resposta existe,
    // mesmo que a dependência nunca responda.
    const started = Date.now();

    await rejectionOf(withDeadline(never(), 60, 'sonda'));

    expect(Date.now() - started).toBeLessThan(600);
  });

  it('o erro diz o que não respondeu e em quanto tempo', async () => {
    const caught = await rejectionOf(
      withDeadline(never(), 40, 'SQS GetQueueUrl'),
    );

    expect(caught).toBeInstanceOf(DeadlineExceededError);
    const failure = caught as DeadlineExceededError;
    expect(failure.label).toBe('SQS GetQueueUrl');
    expect(failure.timeoutMs).toBe(40);
    expect(failure.message).toContain('SQS GetQueueUrl');
    expect(failure.message).toContain('40');
  });

  it('não converte a falha da operação em estouro de prazo', async () => {
    // Indisponibilidade e erro são coisas diferentes, e quem lê o motivo
    // precisa continuar vendo o original.
    const original = new Error('ECONNREFUSED');

    expect(
      await rejectionOf(withDeadline(rejectAfter(10, original), 500, 'sonda')),
    ).toBe(original);
  });

  it('a falha tardia da operação não vira unhandled rejection', async () => {
    const work = rejectAfter(40, new Error('chegou tarde'));

    expect(await rejectionOf(withDeadline(work, 10, 'sonda'))).toBeInstanceOf(
      DeadlineExceededError,
    );

    // Espera passar do instante em que a operação rejeita. Se a rejeição
    // tardia não tivesse handler, o processo registraria unhandled rejection.
    await Bun.sleep(60);
    expect(true).toBe(true);
  });

  it('a folga de cancelamento é positiva e pequena', () => {
    // O cancelamento de verdade deve vencer a corrida; a garantia externa é o
    // backstop, não o caminho normal.
    expect(ABORT_GRACE_MS).toBeGreaterThan(0);
    expect(ABORT_GRACE_MS).toBeLessThan(1_000);
  });
});
