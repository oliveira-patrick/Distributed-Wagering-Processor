import type { Money } from '../money/money';
import type { FailureCode } from '../shared/failure-code';
import { InvariantViolationError } from '../shared/invariant-violation-error';
import type { LedgerDirection } from '../wallet/ledger-direction';
import {
  affectsBalance,
  ledgerDirectionOf,
  requiresReference,
} from './wager-transaction-kind';
import type { WagerTransactionKind } from './wager-transaction-kind';
import {
  canTransition,
  isTerminalStatus,
  WagerTransactionStatus,
} from './wager-transaction-status';

export interface CreateWagerTransactionProps {
  readonly id: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly money: Money;
  // Id no provedor, não o id interno.
  readonly referenceExternalTransactionId?: string | undefined;
  readonly createdAt: Date;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  readonly status: WagerTransactionStatus;
  readonly referenceTransactionId?: string | undefined;
  readonly failureCode?: FailureCode | undefined;
  readonly processedAt?: Date | undefined;
  readonly observedBalance?: Money | undefined;
  readonly referenceAttempts?: number | undefined;
  readonly nextReferenceAttemptAt?: Date | undefined;
}

export class InvalidTransactionStateError extends InvariantViolationError {
  constructor(from: WagerTransactionStatus, to: WagerTransactionStatus) {
    super(`Transição inválida de ${from} para ${to}`);
  }
}

export class MissingReferenceError extends InvariantViolationError {
  constructor(kind: WagerTransactionKind) {
    super(`${kind} exige referenceExternalTransactionId`);
  }
}

export class InvalidTransactionAmountError extends InvariantViolationError {
  constructor(amount: string) {
    super(`O valor da transação precisa ser positivo, recebido ${amount}`);
  }
}

/*
  Transação de aposta.

  Nasce em `PENDING` e caminha para um dos três estados terminais. As
  transições válidas estão em `wager-transaction-status.ts`, com diagrama;
  tentar sair de um terminal lança `InvalidTransactionStateError`, porque é
  erro de programação, não caminho de negócio.

  `OPENING` passa por `create` como qualquer outra: ele é uma transação de
  verdade, interna, que dá origem ao crédito de abertura da wallet. Quem
  recusa `OPENING` vindo de fora é o contrato de entrada — ver
  `isSubmittableKind` —, e não este construtor, que não sabe se a chamada veio
  da API, da fila ou do próprio sistema.
*/
export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId: string | undefined,
    private _failureCode: FailureCode | undefined,
    private _processedAt: Date | undefined,
    private _observedBalance: Money | undefined,
    private _referenceAttempts: number,
    private _nextReferenceAttemptAt: Date | undefined,
  ) {}

  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (!props.money.isPositive()) {
      throw new InvalidTransactionAmountError(props.money.toString());
    }

    if (
      requiresReference(props.kind) &&
      (props.referenceExternalTransactionId === undefined ||
        props.referenceExternalTransactionId === '')
    ) {
      throw new MissingReferenceError(props.kind);
    }

    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId,
      props.createdAt,
      WagerTransactionStatus.Pending,
      undefined,
      undefined,
      undefined,
      undefined,
      0,
      undefined,
    );
  }

  // Reconstrução a partir da persistência — não revalida transições.
  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.createdAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt,
      state.observedBalance,
      state.referenceAttempts ?? 0,
      state.nextReferenceAttemptAt,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  /*
    Saldo da wallet no instante em que esta transação atingiu o estado
    terminal.

    Existe porque repetir uma operação já processada devolve o resultado
    original, **incluindo o saldo observado naquele momento**. Para `BET`,
    `WIN`, `REFUND` e `ROLLBACK` daria para tirar isso do `balanceAfter` do
    lançamento — mas `LOSS` não gera lançamento nenhum e ainda assim precisa
    responder com um saldo. A alternativa, somar o ledger até o ponto daquela
    transação, seria caro e frágil.
  */
  get observedBalance(): Money | undefined {
    return this._observedBalance;
  }

  get referenceAttempts(): number {
    return this._referenceAttempts;
  }

  get nextReferenceAttemptAt(): Date | undefined {
    return this._nextReferenceAttemptAt;
  }

  isTerminal(): boolean {
    return isTerminalStatus(this._status);
  }

  // `false` para `LOSS`, que registra o resultado sem mover saldo.
  affectsBalance(): boolean {
    return affectsBalance(this.kind);
  }

  // `true` para `REFUND` e `ROLLBACK`.
  requiresReference(): boolean {
    return requiresReference(this.kind);
  }

  /*
    Mesma chave de idempotência com payload divergente é **conflito**, não
    replay.
  */
  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  /*
    Direção do lançamento. `ROLLBACK` inverte a direção da referência, então
    precisa dela; os outros tipos já têm direção determinada.
  */
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    return ledgerDirectionOf(this.kind, reference?.kind);
  }

  markProcessed(
    referenceTransactionId: string | undefined,
    at: Date,
    observedBalance: Money,
  ): void {
    this.transitionTo(WagerTransactionStatus.Processed);
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
    this._observedBalance = observedBalance;
    this._nextReferenceAttemptAt = undefined;
  }

  /*
    A referência ainda não apareceu. A transação fica aguardando e será
    reprocessada por worker agendado, com backoff.
  */
  markPendingReference(nextAttemptAt: Date): void {
    this.transitionTo(WagerTransactionStatus.PendingReference);
    this._referenceAttempts += 1;
    this._nextReferenceAttemptAt = nextAttemptAt;
  }

  /*
    Mais uma tentativa frustrada de resolver a referência, sem mudar de
    estado. Existe separado de `markPendingReference` porque
    `PENDING_REFERENCE` não transiciona para si mesmo: continuar esperando
    não é uma transição, é a contagem avançando.
  */
  rescheduleReference(nextAttemptAt: Date): void {
    if (this._status !== WagerTransactionStatus.PendingReference) {
      throw new InvalidTransactionStateError(
        this._status,
        WagerTransactionStatus.PendingReference,
      );
    }
    this._referenceAttempts += 1;
    this._nextReferenceAttemptAt = nextAttemptAt;
  }

  // Recusada por regra de negócio. Não altera saldo nem gera lançamento.
  reject(code: FailureCode, at: Date, observedBalance?: Money): void {
    this.transitionTo(WagerTransactionStatus.Rejected);
    this._failureCode = code;
    this._processedAt = at;
    this._observedBalance = observedBalance;
    this._nextReferenceAttemptAt = undefined;
  }

  // Erro permanente de infraestrutura. Terminal e auditável.
  fail(code: FailureCode, at: Date): void {
    this.transitionTo(WagerTransactionStatus.Failed);
    this._failureCode = code;
    this._processedAt = at;
    this._nextReferenceAttemptAt = undefined;
  }

  private transitionTo(to: WagerTransactionStatus): void {
    if (!canTransition(this._status, to)) {
      throw new InvalidTransactionStateError(this._status, to);
    }
    this._status = to;
  }
}
