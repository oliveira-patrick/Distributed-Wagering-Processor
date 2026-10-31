/*
  Agenda de reprocessamento de referência ausente — ver ADR-004.

  Teste de unidade puro: aritmética, sem relógio real e sem dublê. O que se
  prova é que os números batem com o que o ADR-004 prometeu, porque "8
  tentativas em 24 horas" é afirmação verificável e não slogan.
*/
import { describe, expect, it } from 'bun:test';

import {
  MAX_REFERENCE_ATTEMPTS,
  referenceAttemptsExhausted,
  referenceRetryDelayMs,
} from '../../src/domain/wagering/reference-retry';

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

describe('agenda de referência pendente', () => {
  it('são 8 tentativas, contando a submissão', () => {
    expect(MAX_REFERENCE_ATTEMPTS).toBe(8);
  });

  it('a primeira espera é de 11 minutos', () => {
    expect(referenceRetryDelayMs(1)).toBe(11 * MINUTE_MS);
  });

  it('dobra a cada tentativa', () => {
    const esperado = [11, 22, 44, 88, 176, 352, 704];

    esperado.forEach((minutos, index) => {
      expect(referenceRetryDelayMs(index + 1)).toBe(minutos * MINUTE_MS);
    });
  });

  it('as 7 esperas somam menos de 24 horas', () => {
    // É a promessa do ADR-004. Se a base mudar e a soma passar de 24 h, este
    // teste falha — que é o ponto.
    let total = 0;
    for (let attempt = 1; attempt < MAX_REFERENCE_ATTEMPTS; attempt += 1) {
      total += referenceRetryDelayMs(attempt);
    }

    expect(total).toBeLessThan(DAY_MS);
    expect(total).toBe(1397 * MINUTE_MS);
  });

  it('as 7 esperas cobrem mais de 20 horas', () => {
    // O outro lado: uma janela curta desistiria de referência que ainda vai
    // chegar, e a agenda existe justamente para não fazer isso.
    let total = 0;
    for (let attempt = 1; attempt < MAX_REFERENCE_ATTEMPTS; attempt += 1) {
      total += referenceRetryDelayMs(attempt);
    }

    expect(total).toBeGreaterThan(20 * 60 * MINUTE_MS);
  });

  it('não esgota antes da oitava tentativa', () => {
    for (let attempts = 1; attempts < MAX_REFERENCE_ATTEMPTS; attempts += 1) {
      expect(referenceAttemptsExhausted(attempts)).toBe(false);
    }
  });

  it('esgota na oitava', () => {
    expect(referenceAttemptsExhausted(MAX_REFERENCE_ATTEMPTS)).toBe(true);
    expect(referenceAttemptsExhausted(MAX_REFERENCE_ATTEMPTS + 1)).toBe(true);
  });

  it('nunca devolve espera negativa ou zero', () => {
    for (let attempts = 0; attempts <= 10; attempts += 1) {
      expect(referenceRetryDelayMs(attempts)).toBeGreaterThan(0);
    }
  });
});
