/*
  JSON canônico e `payloadHash`.

  O que se prova aqui é a fronteira entre duas situações que a mesma chave de
  idempotência produz: formatação diferente é a **mesma** operação, campo de
  negócio diferente é conflito.
*/
import { describe, expect, it } from 'bun:test';

import { Money } from '../../../src/domain/money/money';
import { canonicalJson } from '../../../src/domain/shared/canonical-json';
import { hashWagerPayload } from '../../../src/domain/wagering/wager-payload-hash';
import type { WagerPayloadFields } from '../../../src/domain/wagering/wager-payload-hash';
import { WagerTransactionKind } from '../../../src/domain/wagering/wager-transaction-kind';

function fields(
  overrides: Partial<WagerPayloadFields> = {},
): WagerPayloadFields {
  return {
    providerId: 'provider-a',
    externalTransactionId: 'transaction-123',
    playerId: 'player-1',
    walletId: 'wallet-1',
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: WagerTransactionKind.Bet,
    money: Money.from({ amount: '25.00', currency: 'BRL' }),
    referenceExternalTransactionId: undefined,
    ...overrides,
  };
}

describe('canonicalJson', () => {
  it('ordena as chaves, tornando a ordem de inserção irrelevante', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJson({ a: 2, b: 1 })).toBe('{"a":2,"b":1}');
  });

  it('ordena em profundidade', () => {
    expect(canonicalJson({ z: { y: 1, x: 2 } })).toBe('{"z":{"x":2,"y":1}}');
  });

  it('omite chave com valor undefined', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('trata ausência e undefined explícito como a mesma coisa', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
  });

  it('preserva a ordem de array, onde ela é significativa', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
  });

  it('serializa null', () => {
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson({ a: null })).toBe('{"a":null}');
  });

  it('não emite espaços', () => {
    expect(canonicalJson({ a: 1, b: [1, 2] })).toBe('{"a":1,"b":[1,2]}');
  });

  it('recusa bigint, que não é JSON', () => {
    expect(() => canonicalJson({ a: 1n })).toThrow(TypeError);
  });
});

describe('hashWagerPayload — mesma operação', () => {
  it('produz 64 caracteres hexadecimais', () => {
    expect(hashWagerPayload(fields())).toMatch(/^[0-9a-f]{64}$/);
  });

  it('é estável para os mesmos campos', () => {
    expect(hashWagerPayload(fields())).toBe(hashWagerPayload(fields()));
  });

  // O ponto central: hashear o valor de domínio em vez do texto cru. Sem
  // isso, um provedor que reenvia "25" onde antes mandou "25.00" receberia
  // IDEMPOTENCY_CONFLICT em vez de replay.
  it('ignora a formatação do valor monetário', () => {
    const canonical = hashWagerPayload(fields());

    for (const amount of ['25', '25.0', '25.00', '0025.00']) {
      expect(
        hashWagerPayload(
          fields({ money: Money.from({ amount, currency: 'BRL' }) }),
        ),
      ).toBe(canonical);
    }
  });

  it('trata referência ausente e undefined explícito como iguais', () => {
    expect(
      hashWagerPayload(fields({ referenceExternalTransactionId: undefined })),
    ).toBe(hashWagerPayload(fields()));
  });
});

describe('hashWagerPayload — payload divergente', () => {
  const canonical = hashWagerPayload(fields());

  const divergent: readonly (readonly [string, Partial<WagerPayloadFields>])[] =
    [
      [
        'valor diferente',
        { money: Money.from({ amount: '25.01', currency: 'BRL' }) },
      ],
      [
        'moeda diferente',
        { money: Money.from({ amount: '25.00', currency: 'USD' }) },
      ],
      ['kind diferente', { kind: WagerTransactionKind.Win }],
      ['provider diferente', { providerId: 'provider-b' }],
      ['id externo diferente', { externalTransactionId: 'transaction-124' }],
      ['player diferente', { playerId: 'player-2' }],
      ['wallet diferente', { walletId: 'wallet-2' }],
      ['rodada diferente', { roundId: 'round-988' }],
      ['jogo diferente', { gameId: 'other-game' }],
      [
        'referência presente',
        { referenceExternalTransactionId: 'transaction-100' },
      ],
    ];

  for (const [label, overrides] of divergent) {
    it(`muda o hash com ${label}`, () => {
      expect(hashWagerPayload(fields(overrides))).not.toBe(canonical);
    });
  }
});
