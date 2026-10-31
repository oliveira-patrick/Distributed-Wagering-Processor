/*
  Regras puras de `kind` e `status`, sem entidade e sem E/S.

  Ficam separadas do teste da entidade de propósito: são tabelas de decisão —
  transições válidas, o que cada reversão reverte, e o que afeta saldo — e
  testá-las sem construir agregado deixa o erro apontando para a regra, não
  para o construtor.
*/
import { describe, expect, it } from 'bun:test';

import { InvariantViolationError } from '../../../src/domain/shared/invariant-violation-error';
import {
  affectsBalance,
  canReverse,
  isSubmittableKind,
  ledgerDirectionOf,
  requiresReference,
  WagerTransactionKind,
} from '../../../src/domain/wagering/wager-transaction-kind';
import {
  canTransition,
  isTerminalStatus,
  WagerTransactionStatus,
} from '../../../src/domain/wagering/wager-transaction-status';
import { LedgerDirection } from '../../../src/domain/wallet/ledger-direction';

const { Opening, Bet, Win, Loss, Refund, Rollback } = WagerTransactionKind;
const { Pending, PendingReference, Processed, Rejected, Failed } =
  WagerTransactionStatus;
const { Debit, Credit } = LedgerDirection;

describe('kind — submissão externa', () => {
  it('recusa OPENING, que é interno', () => {
    expect(isSubmittableKind(Opening)).toBe(false);
  });

  for (const kind of [Bet, Win, Loss, Refund, Rollback] as const) {
    it(`aceita ${kind}`, () => {
      expect(isSubmittableKind(kind)).toBe(true);
    });
  }
});

describe('kind — efeito no saldo', () => {
  it('LOSS registra o resultado sem mover saldo', () => {
    expect(affectsBalance(Loss)).toBe(false);
  });

  for (const kind of [Opening, Bet, Win, Refund, Rollback] as const) {
    it(`${kind} move saldo`, () => {
      expect(affectsBalance(kind)).toBe(true);
    });
  }
});

describe('kind — exigência de referência', () => {
  for (const kind of [Refund, Rollback] as const) {
    it(`${kind} exige referência`, () => {
      expect(requiresReference(kind)).toBe(true);
    });
  }

  for (const kind of [Opening, Bet, Win, Loss] as const) {
    it(`${kind} não exige referência`, () => {
      expect(requiresReference(kind)).toBe(false);
    });
  }
});

describe('kind — o que cada reversão pode reverter', () => {
  const cases: readonly (readonly [
    WagerTransactionKind,
    WagerTransactionKind,
    boolean,
  ])[] = [
    [Refund, Bet, true],
    [Refund, Win, false],
    [Refund, Refund, false],
    [Refund, Rollback, false],
    [Refund, Loss, false],
    [Refund, Opening, false],
    [Rollback, Bet, true],
    [Rollback, Win, true],
    [Rollback, Refund, true],
    [Rollback, Rollback, false],
    [Rollback, Loss, false],
    [Rollback, Opening, false],
  ];

  for (const [kind, referenceKind, expected] of cases) {
    it(`${kind} ${expected ? 'pode' : 'não pode'} reverter ${referenceKind}`, () => {
      expect(canReverse(kind, referenceKind)).toBe(expected);
    });
  }

  it('não deixa uma reversão reverter outra reversão', () => {
    expect(canReverse(Rollback, Rollback)).toBe(false);
  });
});

describe('kind — direção do lançamento', () => {
  it('BET debita', () => {
    expect(ledgerDirectionOf(Bet)).toBe(Debit);
  });

  it('WIN credita', () => {
    expect(ledgerDirectionOf(Win)).toBe(Credit);
  });

  it('OPENING credita', () => {
    expect(ledgerDirectionOf(Opening)).toBe(Credit);
  });

  it('REFUND de BET credita, invertendo o débito original', () => {
    expect(ledgerDirectionOf(Refund, Bet)).toBe(Credit);
  });

  it('ROLLBACK de BET credita', () => {
    expect(ledgerDirectionOf(Rollback, Bet)).toBe(Credit);
  });

  // Este é o caso que torna REVERSAL_WOULD_OVERDRAW alcançável: reverter um
  // ganho tira dinheiro da wallet, e o saldo pode não cobrir.
  it('ROLLBACK de WIN debita', () => {
    expect(ledgerDirectionOf(Rollback, Win)).toBe(Debit);
  });

  it('ROLLBACK de REFUND debita', () => {
    expect(ledgerDirectionOf(Rollback, Refund)).toBe(Debit);
  });

  it('LOSS não tem direção, e pedi-la é erro de programação', () => {
    expect(() => ledgerDirectionOf(Loss)).toThrow(InvariantViolationError);
  });

  // REFUND só reverte BET (regra 3), que é débito — então a sua direção já
  // está determinada sem consultar a referência. Cobrá-la aqui misturaria o
  // cálculo da direção com a regra de negócio que exige referência, que é
  // `requiresReference` e é validada no caso de uso.
  it('REFUND tem direção determinada mesmo sem referência', () => {
    expect(ledgerDirectionOf(Refund)).toBe(Credit);
  });

  it('ROLLBACK sem referência é erro de programação', () => {
    expect(() => ledgerDirectionOf(Rollback)).toThrow(InvariantViolationError);
  });
});

describe('status — terminalidade', () => {
  for (const status of [Processed, Rejected, Failed] as const) {
    it(`${status} é terminal`, () => {
      expect(isTerminalStatus(status)).toBe(true);
    });
  }

  for (const status of [Pending, PendingReference] as const) {
    it(`${status} não é terminal`, () => {
      expect(isTerminalStatus(status)).toBe(false);
    });
  }
});

describe('status — transições', () => {
  const allowed: readonly (readonly [
    WagerTransactionStatus,
    WagerTransactionStatus,
  ])[] = [
    [Pending, Processed],
    [Pending, PendingReference],
    [Pending, Rejected],
    [Pending, Failed],
    [PendingReference, Processed],
    [PendingReference, Rejected],
    [PendingReference, Failed],
  ];

  for (const [from, to] of allowed) {
    it(`permite ${from} para ${to}`, () => {
      expect(canTransition(from, to)).toBe(true);
    });
  }

  it('não volta de PENDING_REFERENCE para PENDING', () => {
    expect(canTransition(PendingReference, Pending)).toBe(false);
  });

  for (const from of [Processed, Rejected, Failed] as const) {
    for (const to of [
      Pending,
      PendingReference,
      Processed,
      Rejected,
      Failed,
    ] as const) {
      it(`não permite sair de ${from} para ${to}`, () => {
        expect(canTransition(from, to)).toBe(false);
      });
    }
  }
});
