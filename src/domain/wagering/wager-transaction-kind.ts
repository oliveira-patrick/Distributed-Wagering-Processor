import { InvariantViolationError } from '../shared/invariant-violation-error';
import { invertDirection, LedgerDirection } from '../wallet/ledger-direction';

/*
  Tipo de operação de aposta.

  `OPENING` é interno: representa o crédito de abertura da wallet e não pode
  ser submetido pela API nem pela fila.
*/
export const WagerTransactionKind = {
  Opening: 'OPENING',
  Bet: 'BET',
  Win: 'WIN',
  Loss: 'LOSS',
  Refund: 'REFUND',
  Rollback: 'ROLLBACK',
} as const;

export type WagerTransactionKind =
  (typeof WagerTransactionKind)[keyof typeof WagerTransactionKind];

// Aceito na API e na fila. `OPENING` não é.
export function isSubmittableKind(kind: WagerTransactionKind): boolean {
  return kind !== WagerTransactionKind.Opening;
}

// `LOSS` registra o resultado sem mover saldo, logo não gera lançamento.
export function affectsBalance(kind: WagerTransactionKind): boolean {
  return kind !== WagerTransactionKind.Loss;
}

// `REFUND` e `ROLLBACK` exigem referência.
export function requiresReference(kind: WagerTransactionKind): boolean {
  return (
    kind === WagerTransactionKind.Refund ||
    kind === WagerTransactionKind.Rollback
  );
}

/*
  Quais tipos cada reversão pode referenciar.

  `WIN` não aparece como chave porque a sua referência é opcional: ele *pode*
  apontar para a `BET` da mesma rodada, mas isso não o torna uma reversão, e
  nada é invertido por causa disso.
*/
const REVERSIBLE_KINDS: Readonly<
  Partial<Record<WagerTransactionKind, readonly WagerTransactionKind[]>>
> = {
  [WagerTransactionKind.Refund]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Rollback]: [
    WagerTransactionKind.Bet,
    WagerTransactionKind.Win,
    WagerTransactionKind.Refund,
  ],
};

/*
  Se `kind` pode reverter uma referência de tipo `referenceKind`.

  Um `ROLLBACK` apontando para outro `ROLLBACK` cai aqui, e é recusado: a
  regra 3 lista `BET`, `WIN` e `REFUND`, e reverter uma reversão produziria
  uma cadeia sem fim auditável.
*/
export function canReverse(
  kind: WagerTransactionKind,
  referenceKind: WagerTransactionKind,
): boolean {
  return REVERSIBLE_KINDS[kind]?.includes(referenceKind) ?? false;
}

/*
  Direção intrínseca do lançamento, sem consultar referência alguma.

  `REFUND` tem direção determinada mesmo sendo uma reversão: ele só pode
  reverter `BET` (regra 3), que é débito, então é sempre crédito. `ROLLBACK`
  é o único cuja direção depende de quem ele reverte.
*/
function naturalDirection(kind: WagerTransactionKind): LedgerDirection {
  switch (kind) {
    case WagerTransactionKind.Opening:
    case WagerTransactionKind.Win:
    case WagerTransactionKind.Refund:
      return LedgerDirection.Credit;

    case WagerTransactionKind.Bet:
      return LedgerDirection.Debit;

    case WagerTransactionKind.Rollback:
      throw new InvariantViolationError(
        'ROLLBACK não tem direção intrínseca: depende do tipo que ele reverte',
      );

    case WagerTransactionKind.Loss:
      throw new InvariantViolationError(
        'LOSS não gera lançamento no ledger; verifique affectsBalance antes',
      );
  }
}

/*
  Direção do lançamento no ledger.

  `ROLLBACK` inverte a direção da referência, e é daí que sai o caso
  delicado: reverter um `WIN` produz um **débito**, que
  pode deixar o saldo negativo. É por isso que `REVERSAL_WOULD_OVERDRAW`
  existe separado de `INSUFFICIENT_FUNDS`, e por isso esta função precisa da
  referência em vez de decidir só pelo próprio tipo.

  `referenceKind` é exigido apenas para `ROLLBACK`. Para os demais a direção
  já está determinada, e cobrar a referência aqui confundiria duas coisas
  distintas: a regra de negócio que exige referência — que é
  `requiresReference`, validada no caso de uso — e o cálculo da direção.
*/
export function ledgerDirectionOf(
  kind: WagerTransactionKind,
  referenceKind?: WagerTransactionKind,
): LedgerDirection {
  if (kind !== WagerTransactionKind.Rollback) {
    return naturalDirection(kind);
  }

  if (referenceKind === undefined) {
    throw new InvariantViolationError(
      'ROLLBACK precisa da referência para determinar a direção do lançamento',
    );
  }

  return invertDirection(naturalDirection(referenceKind));
}
