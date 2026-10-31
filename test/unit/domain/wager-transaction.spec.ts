// Ciclo de vida da `WagerTransaction`: transições e estados terminais.
import { describe, expect, it } from 'bun:test';

import { Money } from '../../../src/domain/money/money';
import { FailureCode } from '../../../src/domain/shared/failure-code';
import { LedgerDirection } from '../../../src/domain/wallet/ledger-direction';
import { WagerTransactionKind } from '../../../src/domain/wagering/wager-transaction-kind';
import { WagerTransactionStatus } from '../../../src/domain/wagering/wager-transaction-status';
import {
  InvalidTransactionAmountError,
  InvalidTransactionStateError,
  MissingReferenceError,
  WagerTransaction,
} from '../../../src/domain/wagering/wager-transaction';
import type { CreateWagerTransactionProps } from '../../../src/domain/wagering/wager-transaction';

const NOW = new Date('2026-10-29T12:00:00.000Z');
const LATER = new Date('2026-10-29T12:05:00.000Z');

function brl(amount: string): Money {
  return Money.from({ amount, currency: 'BRL' });
}

function props(
  overrides: Partial<CreateWagerTransactionProps> = {},
): CreateWagerTransactionProps {
  return {
    id: 'tx-1',
    providerId: 'provider-a',
    externalTransactionId: 'transaction-123',
    idempotencyKey: 'provider-a:transaction-123',
    payloadHash: 'a'.repeat(64),
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: WagerTransactionKind.Bet,
    money: brl('25.00'),
    createdAt: NOW,
    ...overrides,
  };
}

describe('WagerTransaction — criação', () => {
  it('nasce em PENDING', () => {
    const tx = WagerTransaction.create(props());

    expect(tx.status).toBe(WagerTransactionStatus.Pending);
    expect(tx.isTerminal()).toBe(false);
    expect(tx.processedAt).toBeUndefined();
    expect(tx.failureCode).toBeUndefined();
    expect(tx.observedBalance).toBeUndefined();
  });

  for (const kind of [
    WagerTransactionKind.Refund,
    WagerTransactionKind.Rollback,
  ] as const) {
    it(`recusa ${kind} sem referência`, () => {
      expect(() => WagerTransaction.create(props({ kind }))).toThrow(
        MissingReferenceError,
      );
    });

    it(`recusa ${kind} com referência vazia`, () => {
      expect(() =>
        WagerTransaction.create(
          props({ kind, referenceExternalTransactionId: '' }),
        ),
      ).toThrow(MissingReferenceError);
    });

    it(`aceita ${kind} com referência`, () => {
      const tx = WagerTransaction.create(
        props({ kind, referenceExternalTransactionId: 'transaction-100' }),
      );
      expect(tx.requiresReference()).toBe(true);
    });
  }

  for (const kind of [
    WagerTransactionKind.Bet,
    WagerTransactionKind.Win,
    WagerTransactionKind.Loss,
  ] as const) {
    it(`aceita ${kind} sem referência`, () => {
      const tx = WagerTransaction.create(props({ kind }));
      expect(tx.requiresReference()).toBe(false);
    });
  }

  it('aceita WIN com referência opcional à BET da rodada', () => {
    const tx = WagerTransaction.create(
      props({
        kind: WagerTransactionKind.Win,
        referenceExternalTransactionId: 'transaction-100',
      }),
    );
    expect(tx.referenceExternalTransactionId).toBe('transaction-100');
  });

  it('recusa valor zero', () => {
    expect(() =>
      WagerTransaction.create(props({ money: brl('0.00') })),
    ).toThrow(InvalidTransactionAmountError);
  });

  it('recusa valor negativo', () => {
    expect(() =>
      WagerTransaction.create(props({ money: brl('-1.00') })),
    ).toThrow(InvalidTransactionAmountError);
  });

  it('aceita OPENING, que é interno mas é transação de verdade', () => {
    // Quem recusa OPENING vindo de fora é o contrato de entrada, não o
    // construtor — ele não sabe se a chamada veio da API, da fila ou do
    // próprio sistema.
    const tx = WagerTransaction.create(
      props({ kind: WagerTransactionKind.Opening }),
    );
    expect(tx.kind).toBe(WagerTransactionKind.Opening);
  });
});

describe('WagerTransaction — consultas de domínio', () => {
  it('LOSS não afeta saldo', () => {
    const tx = WagerTransaction.create(
      props({ kind: WagerTransactionKind.Loss }),
    );
    expect(tx.affectsBalance()).toBe(false);
  });

  it('BET afeta saldo', () => {
    expect(WagerTransaction.create(props()).affectsBalance()).toBe(true);
  });

  it('compara o hash do payload', () => {
    const tx = WagerTransaction.create(props());
    expect(tx.matchesPayload('a'.repeat(64))).toBe(true);
    expect(tx.matchesPayload('b'.repeat(64))).toBe(false);
  });

  it('BET debita', () => {
    expect(WagerTransaction.create(props()).ledgerDirectionFor()).toBe(
      LedgerDirection.Debit,
    );
  });

  it('ROLLBACK de WIN debita, invertendo o crédito original', () => {
    const win = WagerTransaction.create(
      props({ id: 'tx-win', kind: WagerTransactionKind.Win }),
    );
    const rollback = WagerTransaction.create(
      props({
        id: 'tx-rb',
        kind: WagerTransactionKind.Rollback,
        referenceExternalTransactionId: 'transaction-100',
      }),
    );

    expect(rollback.ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);
  });

  it('ROLLBACK de BET credita', () => {
    const bet = WagerTransaction.create(props({ id: 'tx-bet' }));
    const rollback = WagerTransaction.create(
      props({
        id: 'tx-rb',
        kind: WagerTransactionKind.Rollback,
        referenceExternalTransactionId: 'transaction-100',
      }),
    );

    expect(rollback.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
  });
});

describe('WagerTransaction — transições', () => {
  it('PENDING para PROCESSED guarda o saldo observado', () => {
    const tx = WagerTransaction.create(props());
    tx.markProcessed('tx-ref', LATER, brl('975.00'));

    expect(tx.status).toBe(WagerTransactionStatus.Processed);
    expect(tx.processedAt).toBe(LATER);
    expect(tx.referenceTransactionId).toBe('tx-ref');
    expect(tx.observedBalance?.toString()).toBe('975.00');
    expect(tx.isTerminal()).toBe(true);
  });

  it('PENDING para REJECTED guarda o código e o saldo observado', () => {
    const tx = WagerTransaction.create(props());
    tx.reject(FailureCode.INSUFFICIENT_FUNDS, LATER, brl('10.00'));

    expect(tx.status).toBe(WagerTransactionStatus.Rejected);
    expect(tx.failureCode).toBe(FailureCode.INSUFFICIENT_FUNDS);
    expect(tx.observedBalance?.toString()).toBe('10.00');
    expect(tx.isTerminal()).toBe(true);
  });

  it('PENDING para FAILED guarda o código', () => {
    const tx = WagerTransaction.create(props());
    tx.fail(FailureCode.TRANSPORT_UNAVAILABLE, LATER);

    expect(tx.status).toBe(WagerTransactionStatus.Failed);
    expect(tx.failureCode).toBe(FailureCode.TRANSPORT_UNAVAILABLE);
    expect(tx.isTerminal()).toBe(true);
  });

  it('PENDING para PENDING_REFERENCE conta a primeira tentativa', () => {
    const tx = WagerTransaction.create(
      props({
        kind: WagerTransactionKind.Refund,
        referenceExternalTransactionId: 'transaction-100',
      }),
    );
    tx.markPendingReference(LATER);

    expect(tx.status).toBe(WagerTransactionStatus.PendingReference);
    expect(tx.referenceAttempts).toBe(1);
    expect(tx.nextReferenceAttemptAt).toBe(LATER);
    expect(tx.isTerminal()).toBe(false);
  });

  it('PENDING_REFERENCE resolve para PROCESSED', () => {
    const tx = WagerTransaction.create(
      props({
        kind: WagerTransactionKind.Refund,
        referenceExternalTransactionId: 'transaction-100',
      }),
    );
    tx.markPendingReference(LATER);
    tx.markProcessed('tx-ref', LATER, brl('100.00'));

    expect(tx.status).toBe(WagerTransactionStatus.Processed);
    expect(tx.nextReferenceAttemptAt).toBeUndefined();
  });

  it('reagenda sem mudar de estado, contando as tentativas', () => {
    const tx = WagerTransaction.create(
      props({
        kind: WagerTransactionKind.Refund,
        referenceExternalTransactionId: 'transaction-100',
      }),
    );
    tx.markPendingReference(LATER);
    tx.rescheduleReference(LATER);
    tx.rescheduleReference(LATER);

    expect(tx.status).toBe(WagerTransactionStatus.PendingReference);
    expect(tx.referenceAttempts).toBe(3);
  });

  it('não reagenda uma transação que não está aguardando referência', () => {
    const tx = WagerTransaction.create(props());
    expect(() => {
      tx.rescheduleReference(LATER);
    }).toThrow(InvalidTransactionStateError);
  });
});

describe('WagerTransaction — estados terminais não transicionam', () => {
  function terminal(apply: (tx: WagerTransaction) => void): WagerTransaction {
    const tx = WagerTransaction.create(props());
    apply(tx);
    return tx;
  }

  const terminals: readonly (readonly [
    string,
    (tx: WagerTransaction) => void,
  ])[] = [
    [
      'PROCESSED',
      (tx): void => {
        tx.markProcessed(undefined, LATER, brl('1.00'));
      },
    ],
    [
      'REJECTED',
      (tx): void => {
        tx.reject(FailureCode.INSUFFICIENT_FUNDS, LATER);
      },
    ],
    [
      'FAILED',
      (tx): void => {
        tx.fail(FailureCode.TRANSPORT_UNAVAILABLE, LATER);
      },
    ],
  ];

  for (const [label, apply] of terminals) {
    it(`${label} recusa markProcessed`, () => {
      const tx = terminal(apply);
      expect(() => {
        tx.markProcessed(undefined, LATER, brl('1.00'));
      }).toThrow(InvalidTransactionStateError);
    });

    it(`${label} recusa reject`, () => {
      const tx = terminal(apply);
      expect(() => {
        tx.reject(FailureCode.INSUFFICIENT_FUNDS, LATER);
      }).toThrow(InvalidTransactionStateError);
    });

    it(`${label} recusa fail`, () => {
      const tx = terminal(apply);
      expect(() => {
        tx.fail(FailureCode.TRANSPORT_UNAVAILABLE, LATER);
      }).toThrow(InvalidTransactionStateError);
    });

    it(`${label} recusa markPendingReference`, () => {
      const tx = terminal(apply);
      expect(() => {
        tx.markPendingReference(LATER);
      }).toThrow(InvalidTransactionStateError);
    });
  }
});

describe('WagerTransaction — reidratação', () => {
  it('reconstrói um estado terminal sem revalidar a transição', () => {
    const tx = WagerTransaction.rehydrate({
      ...props(),
      status: WagerTransactionStatus.Processed,
      processedAt: LATER,
      observedBalance: brl('975.00'),
      referenceTransactionId: 'tx-ref',
    });

    expect(tx.status).toBe(WagerTransactionStatus.Processed);
    expect(tx.observedBalance?.toString()).toBe('975.00');
    expect(tx.referenceAttempts).toBe(0);
  });
});
