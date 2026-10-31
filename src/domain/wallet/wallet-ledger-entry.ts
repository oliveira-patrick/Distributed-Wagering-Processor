import { Money } from '../money/money';
import type { MoneyProps } from '../money/money';
import { DomainError } from '../shared/domain-error';
import { FailureCode } from '../shared/failure-code';
import { InvariantViolationError } from '../shared/invariant-violation-error';
import { LedgerDirection } from './ledger-direction';

export interface CreateLedgerEntryProps {
  readonly id: string;
  readonly walletId: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly money: Money;
  readonly balanceBefore: Money;
  readonly balanceAfter: Money;
  readonly createdAt: Date;
}

export type LedgerEntryState = CreateLedgerEntryProps;

export class UnbalancedLedgerEntryError extends InvariantViolationError {
  constructor(detail: string) {
    super(`Lançamento desbalanceado: ${detail}`);
  }
}

export class NegativeBalanceError extends DomainError {
  readonly failureCode = FailureCode.INSUFFICIENT_FUNDS;

  constructor(balanceAfter: string) {
    super(`O lançamento deixaria o saldo negativo: ${balanceAfter}`);
  }
}

/*
  Lançamento no ledger — imutável por estrutura, não por convenção.

  Não há campo privado mutável nem método de transição: todos os atributos
  são `readonly` e não existe caminho para alterar um lançamento depois de
  criado. Sobrescrever ou excluir lançamento é proibido, e a garantia vive
  também no schema — lá a imutabilidade é um trigger que recusa `UPDATE` e
  `DELETE`. Aqui ela é a ausência de qualquer coisa que permita a escrita.

  `create` valida a aritmética do lançamento. Um lançamento cuja conta não
  fecha não é um lançamento com erro: é um ledger que deixou de ser
  auditável, e sem ledger auditável o sistema todo perde o sentido.
*/
export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly createdAt: Date,
  ) {}

  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    const entry = WalletLedgerEntry.rehydrate(props);

    if (!props.money.isPositive()) {
      throw new UnbalancedLedgerEntryError(
        `o valor precisa ser positivo, recebido ${props.money.toString()}`,
      );
    }

    const currencies = new Set([
      props.money.currency,
      props.balanceBefore.currency,
      props.balanceAfter.currency,
    ]);
    if (currencies.size > 1) {
      throw new UnbalancedLedgerEntryError(
        `moedas divergentes no mesmo lançamento: ${[...currencies].join(', ')}`,
      );
    }

    if (!entry.isBalanced()) {
      throw new UnbalancedLedgerEntryError(
        `${props.balanceBefore.toString()} ${props.direction} ` +
          `${props.money.toString()} não resulta em ${props.balanceAfter.toString()}`,
      );
    }

    /*
      Não-negatividade também vive aqui, além do `check` no schema: um
      lançamento que fecha a conta em saldo negativo é aritmeticamente
      válido e financeiramente proibido.
    */
    if (props.balanceAfter.isNegative()) {
      throw new NegativeBalanceError(props.balanceAfter.toString());
    }

    return entry;
  }

  // Reconstrução a partir da persistência — não revalida nada.
  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      state.createdAt,
    );
  }

  // `balanceBefore ± money === balanceAfter`.
  isBalanced(): boolean {
    const expected =
      this.direction === LedgerDirection.Credit
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money);

    return expected.equals(this.balanceAfter);
  }

  // Efeito com sinal, para reconstruir o saldo somando o ledger.
  signedAmount(): Money {
    return this.direction === LedgerDirection.Credit
      ? this.money
      : this.money.negate();
  }
}

/*
  Reconstrói o saldo somando o ledger inteiro.

  É o lado esquerdo da invariante que **todos** os testes conferem:
  `wallet.balance == saldo reconstruído pelo ledger`. Também é o cálculo que
  o endpoint de reconciliação compara com o saldo materializado.

  A reconciliação de produção faz esta soma dentro do PostgreSQL, sobre
  `numeric`, para não trazer o ledger inteiro para a memória. Esta versão
  existe para os testes e para wallets pequenas, e as duas precisam
  concordar — é por isso que a coluna é `numeric(20, 2)` e não centavos em
  `bigint`: a mesma aritmética exata dos dois lados.
*/
export function rebuildBalance(
  entries: readonly WalletLedgerEntry[],
  currency: string,
): Money {
  return entries.reduce<Money>(
    (total, entry) => total.add(entry.signedAmount()),
    Money.zero(currency),
  );
}

// Forma de fronteira de um lançamento, para presenters e eventos.
export interface LedgerEntryProps {
  readonly id: string;
  readonly walletId: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly money: MoneyProps;
  readonly balanceBefore: MoneyProps;
  readonly balanceAfter: MoneyProps;
  readonly createdAt: string;
}
