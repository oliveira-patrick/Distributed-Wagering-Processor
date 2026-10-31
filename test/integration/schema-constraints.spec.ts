/*
  As garantias que vivem no schema, provadas contra PostgreSQL REAL.

    bun run infra:up && bun run test:integration

  Cada caso escreve SQL **cru**, por fora do domínio e por fora dos mappers.
  É o ponto do teste: unicidade, imutabilidade e não-negatividade precisam
  valer no banco, porque garantia que mora só no código da aplicação não vale
  para o `psql` de madrugada nem para a instância que subiu com outra versão
  do código. Se algum destes casos passar a ser
  aceito, a garantia deixou de existir, mesmo que todo o resto da suíte
  continue verde.

  Os statements vão pela conexão, e não pelo `EntityManager`: assim cada um
  roda na própria transação implícita, e a violação de um não aborta o
  seguinte.
*/
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import { violatedConstraint } from '../../src/infrastructure/persistence/repositories/unique-violation';
import { createTestDatabase } from './support/test-database';
import type { TestDatabase } from './support/test-database';

let db: TestDatabase;

const HASH = 'a'.repeat(64);

function exec(sql: string, params: readonly unknown[] = []): Promise<unknown> {
  return db.orm.em.getConnection().execute(sql, [...params]);
}

// Captura o erro em vez de deixá-lo subir, para poder inspecioná-lo.
async function failureOf(
  sql: string,
  params: readonly unknown[] = [],
): Promise<unknown> {
  try {
    await exec(sql, params);
  } catch (error) {
    return error;
  }
  return undefined;
}

async function expectViolation(
  constraint: string,
  sql: string,
  params: readonly unknown[] = [],
): Promise<void> {
  const error = await failureOf(sql, params);

  expect(error).toBeDefined();
  expect(violatedConstraint(error)).toBe(constraint);
}

/*
  Confirma que a linha foi aceita.

  Escrito assim, e não com o idioma `.resolves` do matcher, porque os
  matchers de `bun:test` são declarados como `void`: aguardar um deles recai
  em `await-thenable` e `no-confusing-void-expression`, duas regras com
  informação de tipos que existem para pegar promessa não aguardada em código
  assíncrono. Elas não vão ser afrouxadas para acomodar um idioma de teste.
*/
async function expectAccepted(work: Promise<string>): Promise<void> {
  expect(await work).toBeString();
}

/*
  Para o caso em que mais de uma constraint recusa a mesma linha por
  construção, e o PostgreSQL relata só uma, à escolha dele. O que o teste
  garante é a recusa; qual das duas falou é indiferente.
*/
async function expectViolationAmong(
  constraints: readonly string[],
  sql: string,
  params: readonly unknown[] = [],
): Promise<void> {
  const error = await failureOf(sql, params);
  const constraint = violatedConstraint(error);

  expect(error).toBeDefined();
  expect(constraint).toBeDefined();
  expect(constraints).toContain(constraint ?? '');
}

interface WalletSeed {
  readonly id?: string;
  readonly playerId?: string;
  readonly currency?: string;
  readonly balanceAmount?: string;
  readonly version?: number;
}

function insertWalletSql(seed: WalletSeed): {
  sql: string;
  params: readonly unknown[];
} {
  return {
    sql: `insert into wallets
            (id, player_id, currency, balance_amount, version,
             created_at, updated_at)
          values (?, ?, ?, ?, ?, now(), now())`,
    params: [
      seed.id ?? randomUUID(),
      seed.playerId ?? randomUUID(),
      seed.currency ?? 'BRL',
      seed.balanceAmount ?? '100.00',
      seed.version ?? 1,
    ],
  };
}

async function insertWallet(seed: WalletSeed = {}): Promise<string> {
  const id = seed.id ?? randomUUID();
  const { sql, params } = insertWalletSql({ ...seed, id });
  await exec(sql, params);
  return id;
}

interface TransactionSeed {
  readonly id?: string;
  readonly walletId: string;
  readonly providerId?: string;
  readonly externalTransactionId?: string;
  readonly idempotencyKey?: string;
  readonly payloadHash?: string;
  readonly kind?: string;
  readonly currency?: string;
  readonly moneyAmount?: string;
  readonly referenceExternalTransactionId?: string | null;
  readonly status?: string;
  readonly failureCode?: string | null;
  readonly processedAt?: string | null;
  readonly observedBalanceAmount?: string | null;
  readonly referenceAttempts?: number;
  readonly nextReferenceAttemptAt?: string | null;
}

function insertTransactionSql(seed: TransactionSeed): {
  sql: string;
  params: readonly unknown[];
} {
  return {
    sql: `insert into wager_transactions
            (id, provider_id, external_transaction_id, idempotency_key,
             payload_hash, wallet_id, player_id, round_id, game_id, kind,
             currency, money_amount, reference_external_transaction_id,
             status, failure_code, processed_at, observed_balance_amount,
             reference_attempts, next_reference_attempt_at, created_at)
          values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                  cast(? as timestamptz), ?, ?, cast(? as timestamptz), now())`,
    params: [
      seed.id ?? randomUUID(),
      seed.providerId ?? 'provider-a',
      seed.externalTransactionId ?? randomUUID(),
      seed.idempotencyKey ?? randomUUID(),
      seed.payloadHash ?? HASH,
      seed.walletId,
      'player-1',
      'round-987',
      'fortune-chimp',
      seed.kind ?? 'BET',
      seed.currency ?? 'BRL',
      seed.moneyAmount ?? '25.00',
      seed.referenceExternalTransactionId ?? null,
      seed.status ?? 'PENDING',
      seed.failureCode ?? null,
      seed.processedAt ?? null,
      seed.observedBalanceAmount ?? null,
      seed.referenceAttempts ?? 0,
      seed.nextReferenceAttemptAt ?? null,
    ],
  };
}

async function insertTransaction(seed: TransactionSeed): Promise<string> {
  const id = seed.id ?? randomUUID();
  const { sql, params } = insertTransactionSql({ ...seed, id });
  await exec(sql, params);
  return id;
}

interface EntrySeed {
  readonly id?: string;
  readonly walletId: string;
  readonly transactionId: string;
  readonly direction?: string;
  readonly currency?: string;
  readonly moneyAmount?: string;
  readonly balanceBeforeAmount?: string;
  readonly balanceAfterAmount?: string;
}

function insertEntrySql(seed: EntrySeed): {
  sql: string;
  params: readonly unknown[];
} {
  return {
    sql: `insert into wallet_ledger_entries
            (id, wallet_id, transaction_id, direction, currency,
             money_amount, balance_before_amount, balance_after_amount,
             created_at)
          values (?, ?, ?, ?, ?, ?, ?, ?, now())`,
    params: [
      seed.id ?? randomUUID(),
      seed.walletId,
      seed.transactionId,
      seed.direction ?? 'DEBIT',
      seed.currency ?? 'BRL',
      seed.moneyAmount ?? '25.00',
      seed.balanceBeforeAmount ?? '100.00',
      seed.balanceAfterAmount ?? '75.00',
    ],
  };
}

async function insertEntry(seed: EntrySeed): Promise<string> {
  const id = seed.id ?? randomUUID();
  const { sql, params } = insertEntrySql({ ...seed, id });
  await exec(sql, params);
  return id;
}

// Wallet e transação válidas, para os casos que precisam de uma base.
async function seedWalletAndTransaction(): Promise<{
  walletId: string;
  transactionId: string;
}> {
  const walletId = await insertWallet();
  const transactionId = await insertTransaction({ walletId });
  return { walletId, transactionId };
}

beforeAll(async () => {
  db = await createTestDatabase('constraints');
}, 120_000);

afterAll(async () => {
  await db.close();
});

describe('wallets', () => {
  it('aceita a linha válida de referência', async () => {
    await expectAccepted(insertWallet());
  });

  it('recusa saldo negativo', async () => {
    const { sql, params } = insertWalletSql({ balanceAmount: '-0.01' });
    await expectViolation('wallets_balance_not_negative', sql, params);
  });

  it('aceita saldo zero', async () => {
    await expectAccepted(insertWallet({ balanceAmount: '0.00' }));
  });

  it('recusa moeda fora do formato ISO-4217', async () => {
    /*
      `BR` chega padded como `BR ` e o cast para texto remove o espaço, então
      sobram dois caracteres e o regex recusa.
    */
    for (const currency of ['br1', 'BR']) {
      const { sql, params } = insertWalletSql({ currency });
      await expectViolation('wallets_currency_iso', sql, params);
    }
  });

  it('recusa moeda longa pelo próprio tipo da coluna', async () => {
    /*
      Quatro caracteres nem chegam ao `check`: `char(3)` recusa antes, com
      erro de dado e não de constraint. Garantia mais forte, mecanismo
      diferente — daí o caso separado.
    */
    const { sql, params } = insertWalletSql({ currency: 'BRLX' });

    const error = await failureOf(sql, params);

    expect(error).toBeDefined();
    expect(violatedConstraint(error)).toBeUndefined();
  });

  it('recusa version abaixo de 1', async () => {
    const { sql, params } = insertWalletSql({ version: 0 });
    await expectViolation('wallets_version_positive', sql, params);
  });

  it('recusa segunda wallet para o mesmo par player e moeda', async () => {
    const playerId = randomUUID();
    await insertWallet({ playerId, currency: 'BRL' });

    const { sql, params } = insertWalletSql({ playerId, currency: 'BRL' });
    await expectViolation('wallets_player_currency_unique', sql, params);
  });

  it('aceita o mesmo player com moedas diferentes', async () => {
    /*
      Uma moeda por linha já atende moedas distintas entre wallets, que é o
      passo multi-moeda realista. Ver ADR-006.
    */
    const playerId = randomUUID();
    await insertWallet({ playerId, currency: 'BRL' });

    await expectAccepted(insertWallet({ playerId, currency: 'USD' }));
  });
});

describe('wager_transactions', () => {
  it('recusa chave de idempotência repetida', async () => {
    const walletId = await insertWallet();
    const idempotencyKey = randomUUID();
    await insertTransaction({ walletId, idempotencyKey });

    const { sql, params } = insertTransactionSql({ walletId, idempotencyKey });
    await expectViolation(
      'wager_transactions_idempotency_key_unique',
      sql,
      params,
    );
  });

  it('recusa o mesmo par provider e id externo', async () => {
    const walletId = await insertWallet();
    const externalTransactionId = randomUUID();
    await insertTransaction({ walletId, externalTransactionId });

    const { sql, params } = insertTransactionSql({
      walletId,
      externalTransactionId,
    });
    await expectViolation(
      'wager_transactions_provider_external_unique',
      sql,
      params,
    );
  });

  it('recusa transação em moeda diferente da wallet', async () => {
    /*
      A foreign key composta é o que torna isso impossível, e é o principal
      ganho de uma moeda por linha: a coerência de moeda entre a transação e
      a wallet é garantida pelo banco, não por constraint de igualdade entre
      colunas da mesma linha.
    */
    const walletId = await insertWallet({ currency: 'BRL' });

    const { sql, params } = insertTransactionSql({
      walletId,
      currency: 'USD',
    });
    await expectViolation(
      'wager_transactions_wallet_currency_fkey',
      sql,
      params,
    );
  });

  it('recusa valor zero ou negativo', async () => {
    const walletId = await insertWallet();

    for (const moneyAmount of ['0.00', '-1.00']) {
      const { sql, params } = insertTransactionSql({ walletId, moneyAmount });
      await expectViolation('wager_transactions_amount_positive', sql, params);
    }
  });

  it('recusa kind e status desconhecidos', async () => {
    const walletId = await insertWallet();

    const kind = insertTransactionSql({ walletId, kind: 'CASHOUT' });
    await expectViolation(
      'wager_transactions_kind_known',
      kind.sql,
      kind.params,
    );

    const status = insertTransactionSql({ walletId, status: 'DONE' });
    await expectViolation(
      'wager_transactions_status_known',
      status.sql,
      status.params,
    );
  });

  it('recusa payload hash que não é SHA-256 hexadecimal', async () => {
    const walletId = await insertWallet();

    const { sql, params } = insertTransactionSql({
      walletId,
      payloadHash: 'Z'.repeat(64),
    });
    await expectViolation(
      'wager_transactions_payload_hash_sha256',
      sql,
      params,
    );
  });

  it('recusa reversão sem referência', async () => {
    const walletId = await insertWallet();

    for (const kind of ['REFUND', 'ROLLBACK']) {
      const missing = insertTransactionSql({ walletId, kind });
      await expectViolation(
        'wager_transactions_reversal_needs_reference',
        missing.sql,
        missing.params,
      );

      const empty = insertTransactionSql({
        walletId,
        kind,
        referenceExternalTransactionId: '',
      });
      await expectViolation(
        'wager_transactions_reversal_needs_reference',
        empty.sql,
        empty.params,
      );
    }
  });

  it('recusa estado terminal sem processed_at', async () => {
    const walletId = await insertWallet();

    const { sql, params } = insertTransactionSql({
      walletId,
      status: 'PROCESSED',
      observedBalanceAmount: '75.00',
    });
    await expectViolation(
      'wager_transactions_terminal_has_processed_at',
      sql,
      params,
    );
  });

  it('recusa processed_at em estado não terminal', async () => {
    const walletId = await insertWallet();

    const { sql, params } = insertTransactionSql({
      walletId,
      status: 'PENDING',
      processedAt: '2026-10-30T12:00:00Z',
    });
    await expectViolation(
      'wager_transactions_terminal_has_processed_at',
      sql,
      params,
    );
  });

  it('recusa recusa sem código de falha', async () => {
    const walletId = await insertWallet();

    const { sql, params } = insertTransactionSql({
      walletId,
      status: 'REJECTED',
      processedAt: '2026-10-30T12:00:00Z',
    });
    await expectViolation(
      'wager_transactions_failure_code_matches_status',
      sql,
      params,
    );
  });

  it('recusa código de falha em transação que não foi recusada', async () => {
    const walletId = await insertWallet();

    const { sql, params } = insertTransactionSql({
      walletId,
      status: 'PROCESSED',
      processedAt: '2026-10-30T12:00:00Z',
      observedBalanceAmount: '75.00',
      failureCode: 'INSUFFICIENT_FUNDS',
    });
    await expectViolation(
      'wager_transactions_failure_code_matches_status',
      sql,
      params,
    );
  });

  it('recusa PROCESSED sem saldo observado', async () => {
    /*
      O replay precisa devolver o saldo observado
      naquele momento. Sem a coluna preenchida, não há o que devolver.
    */
    const walletId = await insertWallet();

    const { sql, params } = insertTransactionSql({
      walletId,
      status: 'PROCESSED',
      processedAt: '2026-10-30T12:00:00Z',
    });
    await expectViolation(
      'wager_transactions_observed_balance_matches_status',
      sql,
      params,
    );
  });

  it('recusa saldo observado em transação ainda pendente', async () => {
    const walletId = await insertWallet();

    const { sql, params } = insertTransactionSql({
      walletId,
      status: 'PENDING',
      observedBalanceAmount: '75.00',
    });
    await expectViolation(
      'wager_transactions_observed_balance_matches_status',
      sql,
      params,
    );
  });

  it('aceita recusa com e sem saldo observado', async () => {
    const walletId = await insertWallet();

    await expectAccepted(
      insertTransaction({
        walletId,
        status: 'REJECTED',
        processedAt: '2026-10-30T12:00:00Z',
        failureCode: 'INSUFFICIENT_FUNDS',
      }),
    );

    await expectAccepted(
      insertTransaction({
        walletId,
        status: 'REJECTED',
        processedAt: '2026-10-30T12:00:00Z',
        failureCode: 'INSUFFICIENT_FUNDS',
        observedBalanceAmount: '10.00',
      }),
    );
  });

  it('exige agendamento exatamente em PENDING_REFERENCE', async () => {
    const walletId = await insertWallet();

    const sem = insertTransactionSql({
      walletId,
      kind: 'REFUND',
      referenceExternalTransactionId: 'transaction-100',
      status: 'PENDING_REFERENCE',
    });
    await expectViolation(
      'wager_transactions_schedule_matches_status',
      sem.sql,
      sem.params,
    );

    const demais = insertTransactionSql({
      walletId,
      status: 'PENDING',
      nextReferenceAttemptAt: '2026-10-30T12:00:00Z',
    });
    await expectViolation(
      'wager_transactions_schedule_matches_status',
      demais.sql,
      demais.params,
    );
  });

  it('recusa a mesma referência revertida duas vezes pelo mesmo tipo', async () => {
    const walletId = await insertWallet();
    const reference = randomUUID();

    await insertTransaction({
      walletId,
      kind: 'ROLLBACK',
      referenceExternalTransactionId: reference,
    });

    const { sql, params } = insertTransactionSql({
      walletId,
      kind: 'ROLLBACK',
      referenceExternalTransactionId: reference,
    });
    await expectViolation(
      'wager_transactions_single_reversal_idx',
      sql,
      params,
    );
  });

  it('aceita tipos de reversão diferentes sobre a mesma referência', async () => {
    const walletId = await insertWallet();
    const reference = randomUUID();

    await insertTransaction({
      walletId,
      kind: 'REFUND',
      referenceExternalTransactionId: reference,
    });

    await expectAccepted(
      insertTransaction({
        walletId,
        kind: 'ROLLBACK',
        referenceExternalTransactionId: reference,
      }),
    );
  });

  it('aceita nova reversão depois de uma recusada', async () => {
    /*
      Reversão recusada não reverteu nada, então não pode bloquear uma
      segunda tentativa legítima — é por isso que o índice é parcial também no status.
    */
    const walletId = await insertWallet();
    const reference = randomUUID();

    await insertTransaction({
      walletId,
      kind: 'ROLLBACK',
      referenceExternalTransactionId: reference,
      status: 'REJECTED',
      processedAt: '2026-10-30T12:00:00Z',
      failureCode: 'REFERENCE_NOT_FOUND',
    });

    await expectAccepted(
      insertTransaction({
        walletId,
        kind: 'ROLLBACK',
        referenceExternalTransactionId: reference,
      }),
    );
  });
});

describe('wallet_ledger_entries', () => {
  it('aceita o lançamento válido de referência', async () => {
    const { walletId, transactionId } = await seedWalletAndTransaction();
    await expectAccepted(insertEntry({ walletId, transactionId }));
  });

  it('recusa débito cuja conta não fecha', async () => {
    const { walletId, transactionId } = await seedWalletAndTransaction();

    const { sql, params } = insertEntrySql({
      walletId,
      transactionId,
      balanceAfterAmount: '74.99',
    });
    await expectViolation('wallet_ledger_entries_balances', sql, params);
  });

  it('recusa crédito lançado com a direção trocada', async () => {
    const { walletId, transactionId } = await seedWalletAndTransaction();

    const { sql, params } = insertEntrySql({
      walletId,
      transactionId,
      direction: 'CREDIT',
      balanceBeforeAmount: '100.00',
      balanceAfterAmount: '75.00',
    });
    await expectViolation('wallet_ledger_entries_balances', sql, params);
  });

  it('recusa direção desconhecida', async () => {
    /*
      Duas constraints recusam, e isso é de propósito: `balances` foi escrita
      como disjunção para ser total por si mesma, então direção fora do par
      conhecido torna os dois lados falsos. A alternativa seria um `case` com
      `else true`, que deixaria a aritmética passar e faria a garantia
      depender de `direction_known` estar lá — mais frágil que esta ambiguidade de mensagem.
    */
    const { walletId, transactionId } = await seedWalletAndTransaction();

    const { sql, params } = insertEntrySql({
      walletId,
      transactionId,
      direction: 'REVERSE',
    });
    await expectViolationAmong(
      [
        'wallet_ledger_entries_direction_known',
        'wallet_ledger_entries_balances',
      ],
      sql,
      params,
    );
  });

  it('recusa valor zero ou negativo', async () => {
    const { walletId, transactionId } = await seedWalletAndTransaction();

    const zero = insertEntrySql({
      walletId,
      transactionId,
      moneyAmount: '0.00',
      balanceAfterAmount: '100.00',
    });
    await expectViolation(
      'wallet_ledger_entries_amount_positive',
      zero.sql,
      zero.params,
    );

    const negativo = insertEntrySql({
      walletId,
      transactionId,
      moneyAmount: '-5.00',
      balanceAfterAmount: '105.00',
    });
    await expectViolation(
      'wallet_ledger_entries_amount_positive',
      negativo.sql,
      negativo.params,
    );
  });

  it('recusa saldo resultante negativo', async () => {
    const { walletId, transactionId } = await seedWalletAndTransaction();

    const { sql, params } = insertEntrySql({
      walletId,
      transactionId,
      moneyAmount: '150.00',
      balanceBeforeAmount: '100.00',
      balanceAfterAmount: '-50.00',
    });
    await expectViolation(
      'wallet_ledger_entries_balance_after_not_negative',
      sql,
      params,
    );
  });

  it('recusa dois lançamentos da mesma transação na mesma wallet', async () => {
    /*
      É a última linha de defesa contra débito duplicado: mesmo que a
      idempotência falhasse, a segunda aplicação colide aqui.
    */
    const { walletId, transactionId } = await seedWalletAndTransaction();
    await insertEntry({ walletId, transactionId });

    const { sql, params } = insertEntrySql({ walletId, transactionId });
    await expectViolation(
      'wallet_ledger_entries_wallet_transaction_unique',
      sql,
      params,
    );
  });

  it('recusa lançamento em moeda diferente da wallet', async () => {
    const walletId = await insertWallet({ currency: 'BRL' });
    const transactionId = await insertTransaction({ walletId });

    const { sql, params } = insertEntrySql({
      walletId,
      transactionId,
      currency: 'USD',
    });
    await expectViolation(
      'wallet_ledger_entries_wallet_currency_fkey',
      sql,
      params,
    );
  });

  it('recusa lançamento sem transação existente', async () => {
    const walletId = await insertWallet();

    const { sql, params } = insertEntrySql({
      walletId,
      transactionId: randomUUID(),
    });
    await expectViolation(
      'wallet_ledger_entries_transaction_fkey',
      sql,
      params,
    );
  });
});

describe('wallet_ledger_entries — append-only', () => {
  async function seedEntry(): Promise<string> {
    const { walletId, transactionId } = await seedWalletAndTransaction();
    return insertEntry({ walletId, transactionId });
  }

  it('recusa update', async () => {
    const id = await seedEntry();

    const error = await failureOf(
      `update wallet_ledger_entries set money_amount = '1.00' where id = ?`,
      [id],
    );

    expect(error).toBeDefined();
    expect(String(error)).toContain('append-only');
  });

  it('recusa delete', async () => {
    const id = await seedEntry();

    const error = await failureOf(
      'delete from wallet_ledger_entries where id = ?',
      [id],
    );

    expect(error).toBeDefined();
    expect(String(error)).toContain('append-only');
  });

  it('recusa truncate', async () => {
    await seedEntry();

    const error = await failureOf('truncate wallet_ledger_entries');

    expect(error).toBeDefined();
    expect(String(error)).toContain('append-only');
  });

  it('deixa a linha intacta depois das tentativas', async () => {
    const id = await seedEntry();

    await failureOf(
      `update wallet_ledger_entries set money_amount = '1.00' where id = ?`,
      [id],
    );
    await failureOf('delete from wallet_ledger_entries where id = ?', [id]);

    const rows = (await exec(
      'select money_amount::text as amount from wallet_ledger_entries where id = ?',
      [id],
    )) as { amount: string }[];

    expect(rows).toHaveLength(1);
    expect(rows[0]?.amount).toBe('25.00');
  });
});

describe('inbox_messages', () => {
  const INSERT = `insert into inbox_messages
      (consumer_name, message_id, payload_hash, received_at)
    values (?, ?, ?, now())`;

  it('recusa a mesma mensagem duas vezes para o mesmo consumidor', async () => {
    const messageId = randomUUID();
    await exec(INSERT, ['wager-consumer', messageId, HASH]);

    await expectViolation('inbox_messages_pkey', INSERT, [
      'wager-consumer',
      messageId,
      HASH,
    ]);
  });

  it('aceita a mesma mensagem para consumidores diferentes', async () => {
    /*
      O `consumerName` entra na chave para que consumidores independentes
      possam processar a mesma mensagem — deduplicar só por `messageId`
      fecharia essa porta sem necessidade.
    */
    const messageId = randomUUID();
    await exec(INSERT, ['wager-consumer', messageId, HASH]);

    expect(
      await failureOf(INSERT, ['audit-consumer', messageId, HASH]),
    ).toBeUndefined();
  });

  it('recusa payload hash fora do formato', async () => {
    await expectViolation('inbox_messages_payload_hash_sha256', INSERT, [
      'wager-consumer',
      randomUUID(),
      'nao-e-sha256',
    ]);
  });
});

describe('outbox_messages', () => {
  const INSERT = `insert into outbox_messages
      (id, aggregate_id, event_type, payload, occurred_at, attempts)
    values (?, ?, ?, cast(? as jsonb), now(), ?)`;

  it('recusa contagem de tentativas negativa', async () => {
    await expectViolation('outbox_messages_attempts_not_negative', INSERT, [
      randomUUID(),
      randomUUID(),
      'WagerTransactionProcessed',
      '{}',
      -1,
    ]);
  });

  it('recusa o mesmo evento duas vezes', async () => {
    const id = randomUUID();
    await exec(INSERT, [id, randomUUID(), 'WalletBalanceChanged', '{}', 0]);

    await expectViolation('outbox_messages_pkey', INSERT, [
      id,
      randomUUID(),
      'WalletBalanceChanged',
      '{}',
      0,
    ]);
  });
});
