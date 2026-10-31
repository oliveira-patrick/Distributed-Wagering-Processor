/*
  Operações e validações de `Money`: escala, ausência de arredondamento e
  recusa de entradas inválidas.
*/
import { describe, expect, it } from 'bun:test';

import {
  CurrencyMismatchError,
  InvalidMoneyError,
  MAX_AMOUNT,
  Money,
  MoneyOverflowError,
} from '../../../src/domain/money/money';

function brl(amount: string): Money {
  return Money.from({ amount, currency: 'BRL' });
}

describe('Money — formatos rejeitados', () => {
  const rejected: readonly (readonly [string, string])[] = [
    ['string vazia', ''],
    ['espaço em branco', ' '],
    ['NaN textual', 'NaN'],
    ['Infinity textual', 'Infinity'],
    ['-Infinity textual', '-Infinity'],
    ['notação científica', '1e3'],
    ['notação científica maiúscula', '1E3'],
    ['notação científica negativa', '2.5e-3'],
    ['três casas decimais', '25.001'],
    ['oito casas decimais', '25.00000000'],
    ['sinal de mais explícito', '+25.00'],
    ['espaço à esquerda', ' 25.00'],
    ['espaço à direita', '25.00 '],
    ['quebra de linha no fim', '25.00\n'],
    ['ponto sem decimais', '25.'],
    ['decimais sem inteiro', '.25'],
    ['hexadecimal', '0x1f'],
    ['binário', '0b101'],
    ['vírgula como separador', '25,00'],
    ['dígitos arábico-índicos', '٢٥'],
    ['texto', 'vinte e cinco'],
    ['dois pontos decimais', '25.00.00'],
    ['dois sinais', '--25.00'],
    ['dezenove dígitos inteiros', '9999999999999999999.99'],
  ];

  for (const [label, amount] of rejected) {
    it(`rejeita ${label}`, () => {
      expect(() => brl(amount)).toThrow(InvalidMoneyError);
    });
  }
});

describe('Money — tipos que não são string', () => {
  // O erro mais provável do mundo real: o provedor manda `"amount": 25.00`
  // sem aspas, e o valor já chegou como float. É dinheiro em ponto
  // flutuante entrando pela porta da frente.
  const notStrings: readonly (readonly [string, unknown])[] = [
    ['número JSON', 25.0],
    ['número inteiro', 25],
    ['null', null],
    ['undefined', undefined],
    ['objeto', {}],
    ['array', []],
    ['boolean', true],
    ['bigint', 25n],
  ];

  for (const [label, value] of notStrings) {
    it(`rejeita ${label}`, () => {
      expect(() =>
        Money.from({ amount: value as string, currency: 'BRL' }),
      ).toThrow(InvalidMoneyError);
    });
  }
});

describe('Money — moeda', () => {
  const rejected: readonly (readonly [string, string])[] = [
    ['minúsculas', 'brl'],
    ['capitalizada', 'Brl'],
    ['duas letras', 'BR'],
    ['quatro letras', 'BRLL'],
    ['vazia', ''],
    ['com dígito', 'BR1'],
    ['com espaço', 'BR '],
  ];

  for (const [label, currency] of rejected) {
    it(`rejeita moeda ${label}`, () => {
      expect(() => Money.from({ amount: '25.00', currency })).toThrow(
        InvalidMoneyError,
      );
    });
  }

  it('aceita ISO-4217 em maiúsculas', () => {
    expect(Money.from({ amount: '25.00', currency: 'USD' }).currency).toBe(
      'USD',
    );
  });
});

describe('Money — normalização de escala', () => {
  const equivalent: readonly (readonly [string, string])[] = [
    ['25', '25.00'],
    ['25.0', '25.00'],
    ['25.00', '25.00'],
    ['0025.00', '25.00'],
    ['25.5', '25.50'],
    ['0', '0.00'],
    ['0.01', '0.01'],
    ['0.1', '0.10'],
    ['-0.00', '0.00'],
    ['-0', '0.00'],
  ];

  for (const [input, expected] of equivalent) {
    it(`normaliza "${input}" para "${expected}"`, () => {
      expect(brl(input).toString()).toBe(expected);
    });
  }

  it('serializa sempre com duas casas, nunca com zero ou uma', () => {
    expect(brl('25').toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
  });

  it('não produz "-0.00"', () => {
    expect(brl('-0.00').toString()).toBe('0.00');
    expect(brl('-0.00').isNegative()).toBe(false);
    expect(brl('-0.00').isZero()).toBe(true);
  });
});

describe('Money — ausência de arredondamento', () => {
  // Como o domínio nunca multiplica nem divide, não existe arredondamento a
  // fazer: o que se prova aqui é que o sistema **recusa** arredondar.
  // Aceitar "25.001" como 25,00 significaria persistir um valor que o
  // provedor não enviou.
  it('recusa a terceira casa em vez de arredondar para baixo', () => {
    expect(() => brl('25.001')).toThrow(InvalidMoneyError);
  });

  it('recusa a terceira casa em vez de arredondar para cima', () => {
    expect(() => brl('25.009')).toThrow(InvalidMoneyError);
  });

  it('recusa meio centavo em vez de escolher um lado', () => {
    expect(() => brl('0.005')).toThrow(InvalidMoneyError);
  });
});

describe('Money — aritmética exata', () => {
  it('soma 0,10 e 0,20 dando exatamente 0,30', () => {
    // O caso canônico de ponto flutuante: 0.1 + 0.2 === 0.30000000000000004.
    expect(brl('0.10').add(brl('0.20')).toString()).toBe('0.30');
  });

  it('soma mil vezes um centavo dando exatamente dez reais', () => {
    let total = Money.zero('BRL');
    for (let i = 0; i < 1000; i += 1) {
      total = total.add(brl('0.01'));
    }
    expect(total.toString()).toBe('10.00');
  });

  it('subtrai mantendo a escala', () => {
    expect(brl('100.00').subtract(brl('80.00')).toString()).toBe('20.00');
  });

  it('subtrai abaixo de zero produzindo negativo', () => {
    expect(brl('10.00').subtract(brl('25.50')).toString()).toBe('-15.50');
  });

  it('nega preservando a magnitude', () => {
    expect(brl('25.00').negate().toString()).toBe('-25.00');
    expect(brl('-25.00').negate().toString()).toBe('25.00');
  });

  it('é imutável: operar não altera o operando', () => {
    const original = brl('25.00');
    original.add(brl('10.00'));
    expect(original.toString()).toBe('25.00');
  });

  it('preserva exatidão em dezoito dígitos inteiros', () => {
    const big = brl('999999999999999999.98');
    expect(big.add(brl('0.01')).toString()).toBe('999999999999999999.99');
  });
});

describe('Money — intervalo representável', () => {
  it('aceita o teto técnico', () => {
    expect(brl(MAX_AMOUNT).toString()).toBe('999999999999999999.99');
  });

  it('recusa soma que estoura o teto', () => {
    expect(() => brl(MAX_AMOUNT).add(brl('0.01'))).toThrow(MoneyOverflowError);
  });

  it('recusa subtração que estoura o piso', () => {
    expect(() => brl(`-${MAX_AMOUNT}`).subtract(brl('0.01'))).toThrow(
      MoneyOverflowError,
    );
  });
});

describe('Money — comparações', () => {
  it('classifica zero, positivo e negativo', () => {
    expect(Money.zero('BRL').isZero()).toBe(true);
    expect(brl('0.01').isPositive()).toBe(true);
    expect(brl('-0.01').isNegative()).toBe(true);
    expect(brl('0.00').isPositive()).toBe(false);
    expect(brl('0.00').isNegative()).toBe(false);
  });

  it('ordena por valor', () => {
    expect(brl('20.00').isLessThan(brl('80.00'))).toBe(true);
    expect(brl('80.00').isLessThan(brl('20.00'))).toBe(false);
    expect(brl('20.00').isLessThan(brl('20.00'))).toBe(false);
  });

  it('considera iguais valores idênticos na mesma moeda', () => {
    expect(brl('25.00').equals(brl('25.0'))).toBe(true);
    expect(brl('25.00').equals(brl('25.01'))).toBe(false);
  });
});

describe('Money — conflito de moeda', () => {
  const usd = Money.from({ amount: '25.00', currency: 'USD' });

  it('lança ao somar moedas diferentes', () => {
    expect(() => brl('25.00').add(usd)).toThrow(CurrencyMismatchError);
  });

  it('lança ao subtrair moedas diferentes', () => {
    expect(() => brl('25.00').subtract(usd)).toThrow(CurrencyMismatchError);
  });

  it('lança ao ordenar moedas diferentes', () => {
    expect(() => brl('25.00').isLessThan(usd)).toThrow(CurrencyMismatchError);
  });

  it('devolve false, sem lançar, ao comparar igualdade entre moedas diferentes', () => {
    // Dois valores em moedas distintas não são iguais — essa é a resposta
    // correta à pergunta, e lançar seria surpreendente.
    expect(brl('25.00').equals(usd)).toBe(false);
  });

  it('carrega o código de falha CURRENCY_MISMATCH', () => {
    try {
      brl('25.00').add(usd);
      throw new Error('deveria ter lançado');
    } catch (error) {
      expect(error).toBeInstanceOf(CurrencyMismatchError);
      expect((error as CurrencyMismatchError).failureCode).toBe(
        'CURRENCY_MISMATCH',
      );
    }
  });
});

describe('Money — serialização', () => {
  it('produz o formato exato do contrato público', () => {
    expect(brl('25.00').toJSON()).toEqual({
      amount: '25.00',
      currency: 'BRL',
    });
  });

  it('sobrevive a JSON.stringify sem lançar por causa do bigint interno', () => {
    expect(JSON.stringify({ money: brl('25.00') })).toBe(
      '{"money":{"amount":"25.00","currency":"BRL"}}',
    );
  });

  it('faz ida e volta sem perda', () => {
    const original = brl('123456789012345678.99');
    expect(Money.from(original.toJSON()).equals(original)).toBe(true);
  });
});
