import { CurrencyMismatchError, Money } from '../money/money';
import { DomainError } from '../shared/domain-error';
import { FailureCode } from '../shared/failure-code';
import { InvariantViolationError } from '../shared/invariant-violation-error';
import { LedgerDirection } from './ledger-direction';
import { WalletLedgerEntry } from './wallet-ledger-entry';

export interface WalletState {
  readonly id: string;
  readonly playerId: string;
  readonly currency: string;
  readonly balance: Money;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface OpenWalletProps {
  readonly id: string;
  readonly playerId: string;
  readonly initialBalance: Money;
  // Id da transação `OPENING`, necessário para o lançamento de abertura.
  readonly openingTransactionId: string;
  readonly openingEntryId: string;
  readonly now: Date;
}

export interface OpenWalletResult {
  readonly wallet: Wallet;
  // Ausente quando o saldo inicial é zero: sem movimento, sem lançamento.
  readonly openingEntry: WalletLedgerEntry | undefined;
}

export interface WalletMovementProps {
  readonly entryId: string;
  readonly transactionId: string;
  readonly money: Money;
  readonly now: Date;
}

export class InsufficientBalanceError extends DomainError {
  readonly failureCode = FailureCode.INSUFFICIENT_FUNDS;

  constructor(balance: string, requested: string) {
    super(`Saldo ${balance} não cobre ${requested}`);
  }
}

export class InvalidInitialBalanceError extends DomainError {
  readonly failureCode = FailureCode.VALIDATION_FAILED;

  constructor(amount: string) {
    super(`Saldo inicial não pode ser negativo: ${amount}`);
  }
}

/*
  Wallet — aggregate root.

  O saldo é materializado aqui e espelhado pelo ledger, e as duas coisas só
  podem divergir se alguém conseguir mover uma sem a outra. É por isso que
  `debit` e `credit` **devolvem o lançamento**: não existe caminho para
  alterar o saldo sem receber de volta a entrada correspondente, o que torna
  a invariante "toda alteração de saldo tem um lançamento, e vice-versa"
  estrutural em vez de uma regra que alguém precisa lembrar de seguir.

  O controle de concorrência não vive aqui. A unidade de concorrência é a
  `walletId` e quem arbitra é o PostgreSQL, com lock pessimista de linha
  dentro da transação do caso de uso — ver ADR-004 e o `ARCHITECTURE.md`. A
  `version` é mantida como trilha de auditoria e segunda barreira, nunca como
  a garantia principal.
*/
export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  /*
    Abre a wallet já com o saldo inicial e devolve o lançamento de abertura.

    A `version` nasce em `1` **mesmo com saldo inicial positivo**: o contrato
    é explícito, `initialBalance` de `1000.00` responde `version: 1`. O
    crédito de abertura faz parte da criação e não conta como "o saldo
    mudou" — se contasse, a resposta seria `version: 2`.

    Daí a assinatura devolver wallet e lançamento juntos, em vez de abrir com
    saldo zero e creditar depois: creditar incrementaria a versão, e não
    existe neste agregado nenhum método capaz de mover o saldo sem
    incrementá-la.
  */
  static open(props: OpenWalletProps): OpenWalletResult {
    if (props.initialBalance.isNegative()) {
      throw new InvalidInitialBalanceError(props.initialBalance.toString());
    }

    const currency = props.initialBalance.currency;
    const wallet = new Wallet(
      props.id,
      props.playerId,
      currency,
      props.initialBalance,
      1,
      props.now,
      props.now,
    );

    if (!props.initialBalance.isPositive()) {
      return { wallet, openingEntry: undefined };
    }

    const openingEntry = WalletLedgerEntry.create({
      id: props.openingEntryId,
      walletId: props.id,
      transactionId: props.openingTransactionId,
      direction: LedgerDirection.Credit,
      money: props.initialBalance,
      balanceBefore: Money.zero(currency),
      balanceAfter: props.initialBalance,
      createdAt: props.now,
    });

    return { wallet, openingEntry };
  }

  // Reconstrução a partir da persistência — não revalida transições.
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  /*
    Se o saldo cobre o valor.

    Existe para que o caso de uso decida o `failureCode` com o contexto que
    ele tem e o agregado não tem: a mesma falta de saldo é
    `INSUFFICIENT_FUNDS` numa `BET` e `REVERSAL_WOULD_OVERDRAW` ao reverter
    um `WIN`, e as duas situações pedem reações diferentes. Consultar antes
    de debitar **não** é o `read → calculate → update` que se quer evitar: a
    consulta e o débito acontecem dentro do mesmo lock de linha, na mesma
    transação.
  */
  covers(money: Money): boolean {
    this.assertSameCurrency(money);
    return !this._balance.isLessThan(money);
  }

  debit(props: WalletMovementProps): WalletLedgerEntry {
    return this.apply(LedgerDirection.Debit, props);
  }

  credit(props: WalletMovementProps): WalletLedgerEntry {
    return this.apply(LedgerDirection.Credit, props);
  }

  private apply(
    direction: LedgerDirection,
    props: WalletMovementProps,
  ): WalletLedgerEntry {
    this.assertSameCurrency(props.money);

    if (!props.money.isPositive()) {
      throw new InvariantViolationError(
        `movimento precisa ser positivo, recebido ${props.money.toString()}`,
      );
    }

    const balanceBefore = this._balance;
    const balanceAfter =
      direction === LedgerDirection.Credit
        ? balanceBefore.add(props.money)
        : balanceBefore.subtract(props.money);

    if (balanceAfter.isNegative()) {
      throw new InsufficientBalanceError(
        balanceBefore.toString(),
        props.money.toString(),
      );
    }

    /*
      O lançamento é criado **antes** de o estado mudar: se a sua validação
      recusar, o agregado fica exatamente como estava. Mutar primeiro
      deixaria a wallet com saldo novo e sem lançamento — a divergência que
      a invariante existe para impedir.
    */
    const entry = WalletLedgerEntry.create({
      id: props.entryId,
      walletId: this.id,
      transactionId: props.transactionId,
      direction,
      money: props.money,
      balanceBefore,
      balanceAfter,
      createdAt: props.now,
    });

    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = props.now;

    return entry;
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}
