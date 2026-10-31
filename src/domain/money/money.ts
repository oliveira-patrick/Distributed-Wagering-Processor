import { DomainError } from '../shared/domain-error';
import { FailureCode } from '../shared/failure-code';

/*
  DTO de fronteira: `amount` como string decimal e `currency` como
  ISO-4217 — é esta a forma que entra e sai do sistema, em
  requisição, resposta, mensagem de fila e payload de evento.
*/
export interface MoneyProps {
  readonly amount: string;
  readonly currency: string;
}

// Casas decimais. Fixo em 2 — ver "Limitações conhecidas" no ARCHITECTURE.md.
export const MONEY_SCALE = 2;

/*
  Dígitos inteiros aceitos. É exatamente a capacidade de `numeric(20, 2)`, a
  coluna que guarda todo valor monetário: recusar aqui transforma um estouro
  de coluna em rejeição de contrato, com código e mensagem úteis, em vez de
  um erro do driver no meio da transação.
*/
export const MAX_INTEGER_DIGITS = 18;

// Teto técnico: `"999999999999999999.99"`.
export const MAX_AMOUNT = `${'9'.repeat(MAX_INTEGER_DIGITS)}.${'9'.repeat(MONEY_SCALE)}`;

const MAX_CENTS = 10n ** BigInt(MAX_INTEGER_DIGITS + MONEY_SCALE) - 1n;

/*
  Teto de negócio por operação, aplicado pelos **contratos de entrada** — não
  por este value object, que precisa representar qualquer saldo acumulado.

  Este limite é decisão nossa, registrada como interpretação. A razão é que
  uma aposta de 10^18 não é aposta, é um dígito a mais num payload — e
  aceitá-la em silêncio significa debitar o erro de digitação de um provedor.
*/
export const MAX_OPERATION_AMOUNT = '1000000000.00';

/*
  Único formato aceito, derivado das constantes acima para que limite e
  validação não possam divergir.

  O portão existe porque `BigInt()` é permissivo de um jeito perigoso para
  dinheiro: `BigInt('')` devolve `0n`, `BigInt(' 12 ')` devolve `12n` e
  `BigInt('0x1f')` devolve `31n`. Entregar string crua a ele transformaria
  campo vazio em zero — num débito, uma aposta de 0,00 aceita como válida.
  Validar antes de converter não é redundância; é o que torna a conversão
  segura.
*/
const AMOUNT_PATTERN = new RegExp(
  `^-?\\d{1,${String(MAX_INTEGER_DIGITS)}}(\\.\\d{1,${String(MONEY_SCALE)}})?$`,
);

// ISO-4217: três letras maiúsculas.
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

export class InvalidMoneyError extends DomainError {
  readonly failureCode = FailureCode.VALIDATION_FAILED;

  constructor(detail: string) {
    super(`Valor monetário inválido: ${detail}`);
  }
}

export class MoneyOverflowError extends DomainError {
  readonly failureCode = FailureCode.VALIDATION_FAILED;

  constructor(cents: bigint) {
    super(
      `Valor monetário fora do intervalo representável (máximo ${MAX_AMOUNT}): ` +
        `${cents.toString()} centavos`,
    );
  }
}

export class CurrencyMismatchError extends DomainError {
  readonly failureCode = FailureCode.CURRENCY_MISMATCH;

  constructor(left: string, right: string) {
    super(`Operação entre moedas diferentes: ${left} e ${right}`);
  }
}

/*
  Valor monetário exato e imutável.

  Internamente é um `bigint` de centavos — a unidade menor da moeda. Três
  razões, nesta ordem: `number`, `float` e `double` estão proibidos para
  dinheiro; o conjunto representável, "múltiplos inteiros de um
  centavo", é **fechado** sob as únicas operações que este domínio executa,
  que são somar, subtrair e negar; e `bigint` não se mistura com `number` nem
  em tempo de compilação nem em runtime, o que transforma essa proibição em
  erro de tipo em vez de disciplina de revisão de código.

  O domínio nunca multiplica nem divide: todo valor é informado pelo provedor
  ou copiado da transação referenciada, porque uma reversão vale exatamente
  o valor da referência e reversão parcial está fora de escopo. Como nenhuma
  operação produz resultado fora do conjunto representável, **não existe
  arredondamento a decidir** — e entrada com mais de duas casas é rejeitada,
  nunca arredondada. Ver ADR-005.
*/
export class Money {
  private constructor(
    private readonly cents: bigint,
    public readonly currency: string,
  ) {
    /*
      Toda operação aritmética passa por aqui, então o teto vale também para
      resultado de soma — não só para o que entra pela fronteira.
    */
    if (cents > MAX_CENTS || cents < -MAX_CENTS) {
      throw new MoneyOverflowError(cents);
    }
  }

  static from(props: MoneyProps): Money {
    const currency = assertCurrency(props.currency);

    /*
      Tipado como `unknown` de propósito: `JSON.parse` entrega `any`, e o
      erro mais provável de um provedor é mandar `"amount": 25.00` sem
      aspas — um float já na origem, exatamente o que não se admite aqui.
    */
    const amount: unknown = props.amount;
    if (typeof amount !== 'string') {
      throw new InvalidMoneyError(
        `amount precisa ser string decimal, recebido ${typeof amount}`,
      );
    }
    if (!AMOUNT_PATTERN.test(amount)) {
      throw new InvalidMoneyError(
        `amount fora do formato: ${JSON.stringify(amount)}`,
      );
    }

    return new Money(toCents(amount), currency);
  }

  static zero(currency: string): Money {
    return new Money(0n, assertCurrency(currency));
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.cents + other.cents, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.cents - other.cents, this.currency);
  }

  negate(): Money {
    return new Money(-this.cents, this.currency);
  }

  isZero(): boolean {
    return this.cents === 0n;
  }

  isPositive(): boolean {
    return this.cents > 0n;
  }

  isNegative(): boolean {
    return this.cents < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.cents < other.cents;
  }

  /*
    Moedas diferentes devolvem `false` em vez de lançar: dois valores em
    moedas distintas não são iguais, e essa é a resposta correta à pergunta.
    Já `isLessThan`, `add` e `subtract` lançam, porque ordenar e somar entre
    moedas não tem resultado definido.
  */
  equals(other: Money): boolean {
    return this.currency === other.currency && this.cents === other.cents;
  }

  // String decimal com escala 2, sempre — `"25.00"`, nunca `"25"`.
  toString(): string {
    const negative = this.cents < 0n;
    const digits = (negative ? -this.cents : this.cents)
      .toString()
      .padStart(MONEY_SCALE + 1, '0');

    const integerPart = digits.slice(0, -MONEY_SCALE);
    const fractionPart = digits.slice(-MONEY_SCALE);

    return `${negative ? '-' : ''}${integerPart}.${fractionPart}`;
  }

  /*
    Rede de segurança, **não** o mecanismo de contrato.

    Existe porque `JSON.stringify` sobre um `bigint` cru lança, e porque o
    a superfície pública do value object o prevê. Mas nenhum contrato externo
    depende de
    `JSON.stringify` encontrar este método por acidente: cada fronteira monta
    o seu DTO explicitamente, num presenter, e tem teste de contrato próprio.
    Deixar a representação interna definir API, outbox e log de uma só vez
    tornaria o acoplamento invisível — e o pior é que funcionaria.
  */
  toJSON(): MoneyProps {
    return { amount: this.toString(), currency: this.currency };
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }
}

/*
  Minúsculas são recusadas em vez de normalizadas. Aceitar `"brl"` e `"BRL"`
  como a mesma coisa obrigaria o índice único de wallet por player e moeda a
  concordar com essa normalização — e uma divergência ali criaria duas
  wallets para o mesmo par.
*/
function assertCurrency(raw: string): string {
  const value: unknown = raw;
  if (typeof value !== 'string' || !CURRENCY_PATTERN.test(value)) {
    throw new InvalidMoneyError(
      `currency precisa ser ISO-4217 em maiúsculas, recebido ${JSON.stringify(raw)}`,
    );
  }
  return value;
}

function toCents(amount: string): bigint {
  const negative = amount.startsWith('-');
  const unsigned = negative ? amount.slice(1) : amount;

  const dot = unsigned.indexOf('.');
  const integerPart = dot === -1 ? unsigned : unsigned.slice(0, dot);
  const fractionPart = dot === -1 ? '' : unsigned.slice(dot + 1);

  /*
    `"25.5"` é 25,50 — a parte fracionária é completada à direita, não à
    esquerda. Preencher do outro lado faria 25,05.
  */
  const cents = BigInt(
    `${integerPart}${fractionPart.padEnd(MONEY_SCALE, '0')}`,
  );
  return negative ? -cents : cents;
}
