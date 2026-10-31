/*
  Contratos de entrada: normalização monetária, limites, sinal e cursor.

  Teste de unidade puro: schemas e funções, sem rede, sem banco, sem dublê.

  É aqui que ficam os critérios 4 e 6 da revisão do `Money`: limites e
  restrição de sinal validados **por operação**, e cobertura de formato
  inválido, borda e serialização.
*/
import { describe, expect, it } from 'bun:test';

import { createWalletSchema } from '../../src/application/contracts/create-wallet.command';
import {
  decodeLedgerCursor,
  encodeLedgerCursor,
} from '../../src/application/contracts/ledger-cursor';
import {
  LEDGER_PAGE_DEFAULT_LIMIT,
  LEDGER_PAGE_MAX_LIMIT,
  ledgerQuerySchema,
} from '../../src/application/contracts/ledger-query.schema';
import {
  moneySchema,
  openingMoneySchema,
  operationMoneySchema,
} from '../../src/application/contracts/money.schema';
import { submitWagerTransactionSchema } from '../../src/application/contracts/submit-wager-transaction.command';
import { MAX_AMOUNT, MAX_OPERATION_AMOUNT } from '../../src/domain/money/money';

const WALLET_ID = '0192f291-27dd-7d3f-8071-5f8685deef37';

function brl(amount: string): { amount: string; currency: string } {
  return { amount, currency: 'BRL' };
}

describe('moneySchema — normalização central', () => {
  it('normaliza formatos equivalentes para a mesma escala', () => {
    for (const entrada of ['25', '25.0', '25.00', '0025.00']) {
      const parsed = moneySchema.parse(brl(entrada));
      expect(parsed.toString()).toBe('25.00');
    }
  });

  it('recusa mais de duas casas decimais, sem arredondar', () => {
    const result = moneySchema.safeParse(brl('25.001'));
    expect(result.success).toBe(false);
  });

  it('recusa número JSON onde o contrato pede string', () => {
    // Sem isto, um `25.1` de JSON viraria string por coerção e o valor
    // atravessaria a fronteira já tendo passado por ponto flutuante.
    const result = moneySchema.safeParse({ amount: 25.1, currency: 'BRL' });
    expect(result.success).toBe(false);
  });

  it('recusa moeda fora de ISO-4217 de três letras maiúsculas', () => {
    for (const currency of ['brl', 'BR', 'BRLX', '']) {
      expect(moneySchema.safeParse({ amount: '1.00', currency }).success).toBe(
        false,
      );
    }
  });

  it('aceita o limite do tipo', () => {
    expect(moneySchema.parse(brl(MAX_AMOUNT)).toString()).toBe(MAX_AMOUNT);
  });

  it('recusa acima do limite do tipo', () => {
    expect(moneySchema.safeParse(brl('9'.repeat(19))).success).toBe(false);
  });

  it('aponta o caminho do campo na falha', () => {
    // É a razão de o zod existir por cima de `Money.from`: o provedor recebe
    // onde está o erro, não só que houve um.
    const result = createWalletSchema.safeParse({
      playerId: 'player-1',
      initialBalance: brl('invalido'),
    });

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]?.path.join('.')).toContain('initialBalance');
  });
});

describe('openingMoneySchema — saldo inicial', () => {
  it('aceita zero', () => {
    expect(openingMoneySchema.parse(brl('0.00')).isZero()).toBe(true);
  });

  it('aceita positivo', () => {
    expect(openingMoneySchema.parse(brl('1000.00')).toString()).toBe('1000.00');
  });

  it('recusa negativo', () => {
    expect(openingMoneySchema.safeParse(brl('-0.01')).success).toBe(false);
  });
});

describe('operationMoneySchema — valor de operação', () => {
  it('recusa zero', () => {
    expect(operationMoneySchema.safeParse(brl('0.00')).success).toBe(false);
  });

  it('recusa negativo', () => {
    // A restrição de sinal está no contrato da **operação**, não no tipo:
    // `Money` precisa representar negativos para `negate` e para a diferença
    // da reconciliação.
    expect(operationMoneySchema.safeParse(brl('-1.00')).success).toBe(false);
  });

  it('aceita o teto da operação', () => {
    expect(
      operationMoneySchema.parse(brl(MAX_OPERATION_AMOUNT)).toString(),
    ).toBe(MAX_OPERATION_AMOUNT);
  });

  it('recusa acima do teto da operação, ainda que caiba no tipo', () => {
    // O tipo representa saldos maiores que qualquer operação individual, e é
    // por isso que os dois limites são diferentes.
    const acimaDoTeto = '1000000000.01';

    expect(moneySchema.safeParse(brl(acimaDoTeto)).success).toBe(true);
    expect(operationMoneySchema.safeParse(brl(acimaDoTeto)).success).toBe(
      false,
    );
  });

  it('aceita um centavo', () => {
    expect(operationMoneySchema.parse(brl('0.01')).toString()).toBe('0.01');
  });
});

describe('submitWagerTransactionSchema', () => {
  function payload(
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      providerId: 'provider-a',
      externalTransactionId: 'transaction-123',
      playerId: 'player-1',
      walletId: WALLET_ID,
      roundId: 'round-987',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: brl('25.00'),
      ...overrides,
    };
  }

  it('aceita o payload do contrato público', () => {
    const parsed = submitWagerTransactionSchema.parse(payload());

    expect(parsed.kind).toBe('BET');
    expect(parsed.money.toString()).toBe('25.00');
  });

  it('recusa OPENING, que é interno', () => {
    expect(
      submitWagerTransactionSchema.safeParse(payload({ kind: 'OPENING' }))
        .success,
    ).toBe(false);
  });

  it('recusa kind desconhecido', () => {
    expect(
      submitWagerTransactionSchema.safeParse(payload({ kind: 'CASHOUT' }))
        .success,
    ).toBe(false);
  });

  it('recusa walletId que não é uuid', () => {
    // O id da wallet é nosso e a coluna é `uuid`; o do provedor é texto.
    expect(
      submitWagerTransactionSchema.safeParse(payload({ walletId: 'abc' }))
        .success,
    ).toBe(false);
  });

  for (const kind of ['REFUND', 'ROLLBACK']) {
    it(`recusa ${kind} sem referência, apontando o campo`, () => {
      const result = submitWagerTransactionSchema.safeParse(payload({ kind }));

      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error.issues[0]?.path.join('.')).toBe(
        'referenceExternalTransactionId',
      );
    });

    it(`aceita ${kind} com referência`, () => {
      const parsed = submitWagerTransactionSchema.parse(
        payload({ kind, referenceExternalTransactionId: 'transaction-100' }),
      );
      expect(parsed.referenceExternalTransactionId).toBe('transaction-100');
    });
  }

  it('aceita WIN com referência opcional', () => {
    const parsed = submitWagerTransactionSchema.parse(
      payload({
        kind: 'WIN',
        referenceExternalTransactionId: 'transaction-100',
      }),
    );
    expect(parsed.referenceExternalTransactionId).toBe('transaction-100');
  });

  it('aceita LOSS sem referência', () => {
    expect(
      submitWagerTransactionSchema.parse(payload({ kind: 'LOSS' })).kind,
    ).toBe('LOSS');
  });

  it('relata todas as questões de uma vez', () => {
    const result = submitWagerTransactionSchema.safeParse(
      payload({ providerId: '', roundId: '', money: brl('0.00') }),
    );

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.length).toBeGreaterThanOrEqual(3);
  });
});

describe('ledgerQuerySchema', () => {
  it('aplica o limite default', () => {
    expect(ledgerQuerySchema.parse({}).limit).toBe(LEDGER_PAGE_DEFAULT_LIMIT);
  });

  it('converte limit de string de query', () => {
    expect(ledgerQuerySchema.parse({ limit: '10' }).limit).toBe(10);
  });

  it('recusa acima do teto, em vez de truncar em silêncio', () => {
    expect(
      ledgerQuerySchema.safeParse({ limit: String(LEDGER_PAGE_MAX_LIMIT + 1) })
        .success,
    ).toBe(false);
  });

  it('recusa limit zero ou negativo', () => {
    expect(ledgerQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
    expect(ledgerQuerySchema.safeParse({ limit: '-1' }).success).toBe(false);
  });
});

describe('cursor do extrato', () => {
  const cursor = {
    createdAt: new Date('2026-10-30T12:00:00.000Z'),
    id: '0192f298-345e-7e38-af88-e43f851a819d',
  };

  it('faz ida e volta sem perder nada', () => {
    const decoded = decodeLedgerCursor(encodeLedgerCursor(cursor));

    expect(decoded?.id).toBe(cursor.id);
    expect(decoded?.createdAt.getTime()).toBe(cursor.createdAt.getTime());
  });

  it('é opaco: não expõe o conteúdo em claro', () => {
    const encoded = encodeLedgerCursor(cursor);

    expect(encoded).not.toContain(cursor.id);
    expect(encoded).not.toContain('2026');
  });

  it('é seguro para URL', () => {
    expect(encodeLedgerCursor(cursor)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('devolve undefined para cursor ilegível', () => {
    for (const invalido of ['', 'nao-base64!!', 'eyJhIjoxfQ']) {
      expect(decodeLedgerCursor(invalido)).toBeUndefined();
    }
  });

  it('devolve undefined para data inválida dentro do cursor', () => {
    const forjado = Buffer.from(
      JSON.stringify({ t: 'nao-e-data', i: 'x' }),
      'utf8',
    ).toString('base64url');

    expect(decodeLedgerCursor(forjado)).toBeUndefined();
  });
});
