// Lançamento do ledger: aritmética validada na factory, e imutabilidade.
import { describe, expect, it } from 'bun:test';

import { Money } from '../../../src/domain/money/money';
import { LedgerDirection } from '../../../src/domain/wallet/ledger-direction';
import {
  NegativeBalanceError,
  UnbalancedLedgerEntryError,
  WalletLedgerEntry,
} from '../../../src/domain/wallet/wallet-ledger-entry';

const NOW = new Date('2026-10-29T12:00:00.000Z');

function brl(amount: string): Money {
  return Money.from({ amount, currency: 'BRL' });
}

function props(overrides: {
  direction?: LedgerDirection;
  money?: string;
  balanceBefore?: string;
  balanceAfter?: string;
}): Parameters<typeof WalletLedgerEntry.create>[0] {
  return {
    id: 'entry-1',
    walletId: 'wallet-1',
    transactionId: 'tx-1',
    direction: overrides.direction ?? LedgerDirection.Debit,
    money: brl(overrides.money ?? '30.00'),
    balanceBefore: brl(overrides.balanceBefore ?? '100.00'),
    balanceAfter: brl(overrides.balanceAfter ?? '70.00'),
    createdAt: NOW,
  };
}

describe('WalletLedgerEntry — aritmética', () => {
  it('aceita débito cuja conta fecha', () => {
    const entry = WalletLedgerEntry.create(props({}));
    expect(entry.isBalanced()).toBe(true);
  });

  it('aceita crédito cuja conta fecha', () => {
    const entry = WalletLedgerEntry.create(
      props({
        direction: LedgerDirection.Credit,
        money: '30.00',
        balanceBefore: '100.00',
        balanceAfter: '130.00',
      }),
    );
    expect(entry.isBalanced()).toBe(true);
  });

  it('recusa débito cuja conta não fecha', () => {
    expect(() =>
      WalletLedgerEntry.create(props({ balanceAfter: '69.99' })),
    ).toThrow(UnbalancedLedgerEntryError);
  });

  it('recusa crédito lançado com a direção trocada', () => {
    // Valores de um crédito, direção de débito: a conta não fecha, e é
    // exatamente o erro que um ledger não auditável esconderia.
    expect(() =>
      WalletLedgerEntry.create(
        props({
          direction: LedgerDirection.Debit,
          money: '30.00',
          balanceBefore: '100.00',
          balanceAfter: '130.00',
        }),
      ),
    ).toThrow(UnbalancedLedgerEntryError);
  });

  it('recusa valor zero', () => {
    expect(() =>
      WalletLedgerEntry.create(
        props({ money: '0.00', balanceAfter: '100.00' }),
      ),
    ).toThrow(UnbalancedLedgerEntryError);
  });

  it('recusa valor negativo', () => {
    expect(() =>
      WalletLedgerEntry.create(
        props({ money: '-5.00', balanceAfter: '105.00' }),
      ),
    ).toThrow(UnbalancedLedgerEntryError);
  });

  it('recusa saldo resultante negativo', () => {
    expect(() =>
      WalletLedgerEntry.create(
        props({
          money: '150.00',
          balanceBefore: '100.00',
          balanceAfter: '-50.00',
        }),
      ),
    ).toThrow(NegativeBalanceError);
  });

  it('recusa moedas divergentes no mesmo lançamento', () => {
    expect(() =>
      WalletLedgerEntry.create({
        id: 'entry-1',
        walletId: 'wallet-1',
        transactionId: 'tx-1',
        direction: LedgerDirection.Debit,
        money: Money.from({ amount: '30.00', currency: 'USD' }),
        balanceBefore: brl('100.00'),
        balanceAfter: brl('70.00'),
        createdAt: NOW,
      }),
    ).toThrow(UnbalancedLedgerEntryError);
  });
});

describe('WalletLedgerEntry — efeito com sinal', () => {
  it('crédito soma', () => {
    const entry = WalletLedgerEntry.create(
      props({
        direction: LedgerDirection.Credit,
        money: '30.00',
        balanceBefore: '100.00',
        balanceAfter: '130.00',
      }),
    );
    expect(entry.signedAmount().toString()).toBe('30.00');
  });

  it('débito subtrai', () => {
    const entry = WalletLedgerEntry.create(props({}));
    expect(entry.signedAmount().toString()).toBe('-30.00');
  });
});

describe('WalletLedgerEntry — reidratação', () => {
  it('não revalida: reconstrói o que já está persistido', () => {
    // `rehydrate` reconstrói estado existente e, pela regra 6.0, não
    // revalida. Um lançamento que já está no banco não vira inválido por ser
    // lido — e se a conta dele não fecha, isso é assunto da reconciliação,
    // não de uma exceção no meio de uma consulta.
    const entry = WalletLedgerEntry.rehydrate({
      id: 'entry-x',
      walletId: 'wallet-1',
      transactionId: 'tx-1',
      direction: LedgerDirection.Debit,
      money: brl('30.00'),
      balanceBefore: brl('100.00'),
      balanceAfter: brl('999.00'),
      createdAt: NOW,
    });

    expect(entry.isBalanced()).toBe(false);
  });
});
