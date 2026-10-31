/*
  Invariantes da `Wallet`: saldo não negativo, moeda única e version.

  Lógica pura, sem E/S. O comportamento sob concorrência real é assunto dos
  testes de F9, contra PostgreSQL de verdade: aqui se prova que o agregado
  mantém saldo e ledger coerentes quando chamado em sequência.
*/
import { describe, expect, it } from 'bun:test';

import { CurrencyMismatchError, Money } from '../../../src/domain/money/money';
import { InvariantViolationError } from '../../../src/domain/shared/invariant-violation-error';
import { LedgerDirection } from '../../../src/domain/wallet/ledger-direction';
import {
  InsufficientBalanceError,
  InvalidInitialBalanceError,
  Wallet,
} from '../../../src/domain/wallet/wallet';
import type { WalletLedgerEntry } from '../../../src/domain/wallet/wallet-ledger-entry';
import { rebuildBalance } from '../../../src/domain/wallet/wallet-ledger-entry';

const NOW = new Date('2026-10-29T12:00:00.000Z');

function brl(amount: string): Money {
  return Money.from({ amount, currency: 'BRL' });
}

function openWallet(initial: string): {
  wallet: Wallet;
  openingEntry: WalletLedgerEntry | undefined;
} {
  return Wallet.open({
    id: 'wallet-1',
    playerId: 'player-1',
    initialBalance: brl(initial),
    openingTransactionId: 'tx-opening',
    openingEntryId: 'entry-opening',
    now: NOW,
  });
}

describe('Wallet — abertura', () => {
  it('nasce com version 1 mesmo com saldo inicial positivo', () => {
    // O contrato é explícito: um saldo inicial de 1000.00 responde
    // version 1. O crédito de abertura faz parte da criação, e não conta como
    // "o saldo mudou" — se contasse, a resposta seria version 2.
    const { wallet } = openWallet('1000.00');

    expect(wallet.version).toBe(1);
    expect(wallet.balance.toString()).toBe('1000.00');
  });

  it('gera lançamento de crédito de zero até o saldo inicial', () => {
    const { openingEntry } = openWallet('1000.00');

    expect(openingEntry).toBeDefined();
    expect(openingEntry?.direction).toBe(LedgerDirection.Credit);
    expect(openingEntry?.money.toString()).toBe('1000.00');
    expect(openingEntry?.balanceBefore.toString()).toBe('0.00');
    expect(openingEntry?.balanceAfter.toString()).toBe('1000.00');
    expect(openingEntry?.transactionId).toBe('tx-opening');
  });

  it('não gera lançamento quando o saldo inicial é zero', () => {
    const { wallet, openingEntry } = openWallet('0.00');

    expect(openingEntry).toBeUndefined();
    expect(wallet.version).toBe(1);
    expect(wallet.balance.isZero()).toBe(true);
  });

  it('recusa saldo inicial negativo', () => {
    expect(() => openWallet('-0.01')).toThrow(InvalidInitialBalanceError);
  });

  it('herda a moeda do saldo inicial', () => {
    const { wallet } = Wallet.open({
      id: 'wallet-2',
      playerId: 'player-2',
      initialBalance: Money.from({ amount: '10.00', currency: 'USD' }),
      openingTransactionId: 'tx',
      openingEntryId: 'entry',
      now: NOW,
    });

    expect(wallet.currency).toBe('USD');
  });
});

describe('Wallet — débito', () => {
  it('reduz o saldo e devolve o lançamento correspondente', () => {
    const { wallet } = openWallet('100.00');

    const entry = wallet.debit({
      entryId: 'entry-1',
      transactionId: 'tx-1',
      money: brl('30.00'),
      now: NOW,
    });

    expect(wallet.balance.toString()).toBe('70.00');
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.balanceBefore.toString()).toBe('100.00');
    expect(entry.balanceAfter.toString()).toBe('70.00');
    expect(entry.isBalanced()).toBe(true);
  });

  it('incrementa a version a cada movimento', () => {
    const { wallet } = openWallet('100.00');

    wallet.debit({
      entryId: 'e1',
      transactionId: 't1',
      money: brl('10.00'),
      now: NOW,
    });
    expect(wallet.version).toBe(2);

    wallet.debit({
      entryId: 'e2',
      transactionId: 't2',
      money: brl('10.00'),
      now: NOW,
    });
    expect(wallet.version).toBe(3);
  });

  it('permite zerar o saldo exatamente', () => {
    const { wallet } = openWallet('50.00');

    wallet.debit({
      entryId: 'e1',
      transactionId: 't1',
      money: brl('50.00'),
      now: NOW,
    });

    expect(wallet.balance.toString()).toBe('0.00');
  });

  it('recusa débito acima do saldo', () => {
    const { wallet } = openWallet('50.00');

    expect(() =>
      wallet.debit({
        entryId: 'e1',
        transactionId: 't1',
        money: brl('50.01'),
        now: NOW,
      }),
    ).toThrow(InsufficientBalanceError);
  });

  it('deixa o agregado intacto quando o débito é recusado', () => {
    // Se o estado fosse mutado antes da validação do lançamento, a wallet
    // ficaria com saldo novo e sem entrada no ledger — exatamente a
    // divergência que a invariante existe para impedir.
    const { wallet } = openWallet('50.00');

    expect(() =>
      wallet.debit({
        entryId: 'e1',
        transactionId: 't1',
        money: brl('80.00'),
        now: NOW,
      }),
    ).toThrow(InsufficientBalanceError);

    expect(wallet.balance.toString()).toBe('50.00');
    expect(wallet.version).toBe(1);
  });

  it('recusa movimento de valor zero ou negativo', () => {
    const { wallet } = openWallet('50.00');

    expect(() =>
      wallet.debit({
        entryId: 'e1',
        transactionId: 't1',
        money: brl('0.00'),
        now: NOW,
      }),
    ).toThrow(InvariantViolationError);

    expect(() =>
      wallet.debit({
        entryId: 'e2',
        transactionId: 't2',
        money: brl('-5.00'),
        now: NOW,
      }),
    ).toThrow(InvariantViolationError);
  });
});

describe('Wallet — crédito', () => {
  it('aumenta o saldo e devolve o lançamento', () => {
    const { wallet } = openWallet('10.00');

    const entry = wallet.credit({
      entryId: 'e1',
      transactionId: 't1',
      money: brl('15.50'),
      now: NOW,
    });

    expect(wallet.balance.toString()).toBe('25.50');
    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(entry.balanceAfter.toString()).toBe('25.50');
    expect(wallet.version).toBe(2);
  });
});

describe('Wallet — moeda', () => {
  const usd = Money.from({ amount: '10.00', currency: 'USD' });

  it('recusa débito em moeda diferente', () => {
    const { wallet } = openWallet('100.00');

    expect(() =>
      wallet.debit({
        entryId: 'e1',
        transactionId: 't1',
        money: usd,
        now: NOW,
      }),
    ).toThrow(CurrencyMismatchError);
  });

  it('recusa crédito em moeda diferente', () => {
    const { wallet } = openWallet('100.00');

    expect(() =>
      wallet.credit({
        entryId: 'e1',
        transactionId: 't1',
        money: usd,
        now: NOW,
      }),
    ).toThrow(CurrencyMismatchError);
  });

  it('recusa consulta de cobertura em moeda diferente', () => {
    const { wallet } = openWallet('100.00');
    expect(() => wallet.covers(usd)).toThrow(CurrencyMismatchError);
  });
});

describe('Wallet — cobertura de saldo', () => {
  it('responde se o saldo cobre o valor sem alterar nada', () => {
    const { wallet } = openWallet('100.00');

    expect(wallet.covers(brl('100.00'))).toBe(true);
    expect(wallet.covers(brl('100.01'))).toBe(false);
    expect(wallet.version).toBe(1);
    expect(wallet.balance.toString()).toBe('100.00');
  });
});

describe('Wallet — invariante saldo igual ao ledger', () => {
  it('mantém o saldo igual à soma do ledger ao longo de vários movimentos', () => {
    const { wallet, openingEntry } = openWallet('100.00');
    const entries: WalletLedgerEntry[] = [];
    if (openingEntry !== undefined) entries.push(openingEntry);

    entries.push(
      wallet.debit({
        entryId: 'e1',
        transactionId: 't1',
        money: brl('30.00'),
        now: NOW,
      }),
    );
    entries.push(
      wallet.credit({
        entryId: 'e2',
        transactionId: 't2',
        money: brl('5.50'),
        now: NOW,
      }),
    );
    entries.push(
      wallet.debit({
        entryId: 'e3',
        transactionId: 't3',
        money: brl('0.50'),
        now: NOW,
      }),
    );

    expect(wallet.balance.toString()).toBe('75.00');
    expect(rebuildBalance(entries, 'BRL').equals(wallet.balance)).toBe(true);
  });

  it('mantém a invariante quando a wallet abre em zero', () => {
    const { wallet, openingEntry } = openWallet('0.00');
    const entries: WalletLedgerEntry[] = [];
    if (openingEntry !== undefined) entries.push(openingEntry);

    entries.push(
      wallet.credit({
        entryId: 'e1',
        transactionId: 't1',
        money: brl('42.00'),
        now: NOW,
      }),
    );

    expect(rebuildBalance(entries, 'BRL').equals(wallet.balance)).toBe(true);
  });
});

describe('Wallet — disputa pelo saldo, em sequência', () => {
  // A versão concorrente de verdade, com paralelismo real e PostgreSQL, é
  // assunto de F9. Aqui se prova que a regra do agregado produz o resultado
  // esperado: a segunda aposta não cabe.
  it('aceita uma aposta de 80,00 e recusa a segunda, terminando em 20,00', () => {
    const { wallet } = openWallet('100.00');

    wallet.debit({
      entryId: 'e1',
      transactionId: 't1',
      money: brl('80.00'),
      now: NOW,
    });

    expect(wallet.covers(brl('80.00'))).toBe(false);
    expect(() =>
      wallet.debit({
        entryId: 'e2',
        transactionId: 't2',
        money: brl('80.00'),
        now: NOW,
      }),
    ).toThrow(InsufficientBalanceError);

    expect(wallet.balance.toString()).toBe('20.00');
    expect(wallet.version).toBe(2);
  });
});

describe('Wallet — reidratação', () => {
  it('reconstrói o estado sem revalidar transições', () => {
    const wallet = Wallet.rehydrate({
      id: 'wallet-9',
      playerId: 'player-9',
      currency: 'BRL',
      balance: brl('77.77'),
      version: 12,
      createdAt: NOW,
      updatedAt: NOW,
    });

    expect(wallet.balance.toString()).toBe('77.77');
    expect(wallet.version).toBe(12);
  });
});
