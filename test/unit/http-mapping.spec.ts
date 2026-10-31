/*
  Mapeamento de falha para HTTP e contratos de representação da saída.

  Teste de unidade puro: funções e objetos de domínio, sem rede e sem dublê.
*/
import { describe, expect, it } from 'bun:test';
import { HttpStatus } from '@nestjs/common';

import { Money } from '../../src/domain/money/money';
import { FailureCode } from '../../src/domain/shared/failure-code';
import { WagerTransaction } from '../../src/domain/wagering/wager-transaction';
import { WagerTransactionKind } from '../../src/domain/wagering/wager-transaction-kind';
import { WagerTransactionStatus } from '../../src/domain/wagering/wager-transaction-status';
import { Wallet } from '../../src/domain/wallet/wallet';
import {
  httpStatusFor,
  httpStatusForTransaction,
} from '../../src/interfaces/http/failure-http';
import { presentMoney } from '../../src/interfaces/http/presenters/money.presenter';
import {
  presentLedgerEntry,
  presentLedgerPage,
  presentWallet,
} from '../../src/interfaces/http/presenters/wallet.presenter';
import {
  presentSubmitResult,
  presentTransaction,
} from '../../src/interfaces/http/presenters/wagering.presenter';

const NOW = new Date('2026-10-30T12:00:00.000Z');

function brl(amount: string): Money {
  return Money.from({ amount, currency: 'BRL' });
}

function openWallet(): ReturnType<typeof Wallet.open> {
  return Wallet.open({
    id: '0192f291-27dd-7d3f-8071-5f8685deef37',
    playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
    initialBalance: brl('1000.00'),
    openingTransactionId: 'tx-opening',
    openingEntryId: 'entry-opening',
    now: NOW,
  });
}

function bet(): WagerTransaction {
  return WagerTransaction.create({
    id: '0192f298-345e-7e38-af88-e43f851a819d',
    providerId: 'provider-a',
    externalTransactionId: 'transaction-123',
    idempotencyKey: 'provider-a:transaction-123',
    payloadHash: 'a'.repeat(64),
    walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
    playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: WagerTransactionKind.Bet,
    money: brl('25.00'),
    createdAt: NOW,
  });
}

describe('mapa de falha para status', () => {
  it('cobre todos os códigos da taxonomia', () => {
    // O mapa é `Record` total, então código novo sem status não compila. Este
    // teste garante que nenhum caia num `undefined` em tempo de execução.
    for (const code of Object.values(FailureCode)) {
      expect(typeof httpStatusFor(code)).toBe('number');
    }
  });

  it('distingue as cinco situações que a API precisa separar', () => {
    expect(httpStatusFor(FailureCode.VALIDATION_FAILED)).toBe(
      HttpStatus.BAD_REQUEST,
    );
    expect(httpStatusFor(FailureCode.IDEMPOTENCY_CONFLICT)).toBe(
      HttpStatus.CONFLICT,
    );
    expect(httpStatusFor(FailureCode.INSUFFICIENT_FUNDS)).toBe(
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
    expect(
      httpStatusForTransaction(
        WagerTransactionStatus.PendingReference,
        undefined,
      ),
    ).toBe(HttpStatus.ACCEPTED);
    expect(httpStatusFor(FailureCode.TRANSPORT_UNAVAILABLE)).toBe(
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  });

  it('separa 400 de 422: requisição errada contra negócio que recusou', () => {
    expect(httpStatusFor(FailureCode.VALIDATION_FAILED)).toBe(
      HttpStatus.BAD_REQUEST,
    );

    for (const code of [
      FailureCode.CURRENCY_MISMATCH,
      FailureCode.INSUFFICIENT_FUNDS,
      FailureCode.REVERSAL_WOULD_OVERDRAW,
      FailureCode.REFERENCE_NOT_FOUND,
      FailureCode.REFERENCE_MISMATCH,
      FailureCode.REFERENCE_KIND_INVALID,
      FailureCode.ALREADY_REVERSED,
      FailureCode.AMOUNT_MISMATCH,
    ]) {
      expect(httpStatusFor(code)).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    }
  });

  it('reversão que estouraria o saldo tem status próprio do seu código', () => {
    // Os dois são 422, e o que distingue é o código no corpo: as duas
    // situações pedem reações diferentes do provedor.
    expect(httpStatusFor(FailureCode.REVERSAL_WOULD_OVERDRAW)).toBe(
      httpStatusFor(FailureCode.INSUFFICIENT_FUNDS),
    );
  });

  it('aplicada responde 200, não 201', () => {
    // O contrato promete que requisição idêntica devolve a mesma resposta.
    // Com 201 no original e 200 no replay, a promessa não valeria.
    expect(
      httpStatusForTransaction(WagerTransactionStatus.Processed, undefined),
    ).toBe(HttpStatus.OK);
  });

  it('recusada sai pelo código de falha', () => {
    expect(
      httpStatusForTransaction(
        WagerTransactionStatus.Rejected,
        FailureCode.INSUFFICIENT_FUNDS,
      ),
    ).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
  });

  it('falha de infraestrutura persistida responde 503', () => {
    expect(
      httpStatusForTransaction(
        WagerTransactionStatus.Failed,
        FailureCode.TRANSPORT_UNAVAILABLE,
      ),
    ).toBe(HttpStatus.SERVICE_UNAVAILABLE);
  });
});

describe('presenter de dinheiro', () => {
  it('devolve string decimal de escala 2, nunca número', () => {
    const response = presentMoney(brl('25'));

    expect(response).toEqual({ amount: '25.00', currency: 'BRL' });
    expect(typeof response.amount).toBe('string');
  });

  it('preserva o limite sem perder centavo', () => {
    expect(presentMoney(brl('999999999999999999.99')).amount).toBe(
      '999999999999999999.99',
    );
  });

  it('sobrevive a JSON.stringify como string', () => {
    const body = JSON.stringify(presentMoney(brl('0.10')));

    expect(body).toContain('"amount":"0.10"');
    expect(body).not.toContain('"amount":0.1');
  });
});

describe('presenter de wallet', () => {
  it('devolve exatamente os campos do contrato de submissão', () => {
    const { wallet } = openWallet();

    expect(presentWallet(wallet)).toEqual({
      id: '0192f291-27dd-7d3f-8071-5f8685deef37',
      playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
      balance: { amount: '1000.00', currency: 'BRL' },
      version: 1,
    });
  });
});

describe('presenter de extrato', () => {
  it('serializa o lançamento com os três valores e o instante em ISO', () => {
    const { openingEntry } = openWallet();
    if (openingEntry === undefined) throw new Error('sem lançamento');

    expect(presentLedgerEntry(openingEntry)).toEqual({
      id: 'entry-opening',
      transactionId: 'tx-opening',
      direction: 'CREDIT',
      money: { amount: '1000.00', currency: 'BRL' },
      balanceBefore: { amount: '0.00', currency: 'BRL' },
      balanceAfter: { amount: '1000.00', currency: 'BRL' },
      createdAt: '2026-10-30T12:00:00.000Z',
    });
  });

  it('omite o cursor na última página, em vez de mandar null', () => {
    const page = presentLedgerPage([], undefined);

    expect(page).not.toHaveProperty('nextCursor');
    expect(JSON.stringify(page)).not.toContain('nextCursor');
  });

  it('inclui o cursor quando há próxima página', () => {
    expect(presentLedgerPage([], 'abc').nextCursor).toBe('abc');
  });
});

describe('presenter de submissão', () => {
  it('devolve os quatro campos do contrato de wallet', () => {
    const transaction = bet();
    transaction.markProcessed(undefined, NOW, brl('975.00'));

    expect(presentSubmitResult(transaction, brl('975.00'), false)).toEqual({
      transactionId: '0192f298-345e-7e38-af88-e43f851a819d',
      status: 'PROCESSED',
      balance: { amount: '975.00', currency: 'BRL' },
      idempotentReplay: false,
    });
  });

  it('não carrega failureCode quando foi aplicada', () => {
    const transaction = bet();
    transaction.markProcessed(undefined, NOW, brl('975.00'));

    expect(
      JSON.stringify(presentSubmitResult(transaction, brl('975.00'), false)),
    ).not.toContain('failureCode');
  });

  it('carrega o código na recusa, no mesmo corpo do sucesso', () => {
    const transaction = bet();
    transaction.reject(FailureCode.INSUFFICIENT_FUNDS, NOW, brl('10.00'));

    expect(presentSubmitResult(transaction, brl('10.00'), false)).toEqual({
      transactionId: '0192f298-345e-7e38-af88-e43f851a819d',
      status: 'REJECTED',
      balance: { amount: '10.00', currency: 'BRL' },
      idempotentReplay: false,
      failureCode: 'INSUFFICIENT_FUNDS',
    });
  });

  it('marca o replay', () => {
    const transaction = bet();
    transaction.markProcessed(undefined, NOW, brl('975.00'));

    expect(
      presentSubmitResult(transaction, brl('975.00'), true).idempotentReplay,
    ).toBe(true);
  });
});

describe('presenter de transação', () => {
  it('omite os campos ausentes em vez de emitir null', () => {
    const body = JSON.stringify(presentTransaction(bet()));

    for (const campo of [
      'observedBalance',
      'failureCode',
      'processedAt',
      'referenceExternalTransactionId',
      'referenceTransactionId',
      'nextReferenceAttemptAt',
    ]) {
      expect(body).not.toContain(campo);
    }
  });

  it('inclui saldo observado e instante quando a transação terminou', () => {
    const transaction = bet();
    transaction.markProcessed('tx-ref', NOW, brl('975.00'));

    const response = presentTransaction(transaction);

    expect(response.observedBalance).toEqual({
      amount: '975.00',
      currency: 'BRL',
    });
    expect(response.processedAt).toBe('2026-10-30T12:00:00.000Z');
    expect(response.referenceTransactionId).toBe('tx-ref');
  });

  it('expõe o agendamento quando está aguardando referência', () => {
    const transaction = WagerTransaction.create({
      id: '0192f299-0000-7000-8000-000000000001',
      providerId: 'provider-a',
      externalTransactionId: 'transaction-200',
      idempotencyKey: 'provider-a:transaction-200',
      payloadHash: 'b'.repeat(64),
      walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
      playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
      roundId: 'round-987',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Refund,
      money: brl('25.00'),
      referenceExternalTransactionId: 'transaction-100',
      createdAt: NOW,
    });
    const later = new Date(NOW.getTime() + 660_000);
    transaction.markPendingReference(later);

    const response = presentTransaction(transaction);

    expect(response.status).toBe('PENDING_REFERENCE');
    expect(response.referenceAttempts).toBe(1);
    expect(response.nextReferenceAttemptAt).toBe(later.toISOString());
  });
});
