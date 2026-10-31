/*
  Os sete endpoints públicos, contra PostgreSQL REAL — nenhum mock.

    bun run infra:up && bun run test:integration

  A aplicação sobe de verdade: `ConfigModule`, `PersistenceModule` e
  `ApiModule`, com os casos de uso compostos como em produção. Nenhum
  repositório é substituído, e é deliberado — o savepoint da idempotência, o
  lock de linha e as constraints do schema são justamente onde está a
  corretude, e um repositório em memória não reproduz nenhum dos três.

  Em todo teste que move saldo, a invariante global é conferida:
  `wallet.balance` igual à soma com sinal do ledger.
*/
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { createTestDatabase } from './support/test-database';
import type { TestDatabase } from './support/test-database';

/*
  Opcionais porque é a verdade: `beforeAll` pode falhar no meio — um
  PostgreSQL fora do ar basta — e aí o `afterAll` e os casos rodam com as duas
  ainda vazias. Declarar como sempre definidas fazia o lint recusar as guardas
  que o tempo de execução exige.
*/
let db: TestDatabase | undefined;
let app: INestApplication | undefined;
let previousDatabase: string | undefined;

function http(): ReturnType<typeof request> {
  if (app === undefined) {
    throw new Error('a aplicação não subiu; veja a falha do beforeAll');
  }
  return request(app.getHttpServer() as Server);
}

/*
  SQL cru pela conexão de conferência.

  O resultado é convertido na saída em vez de repassar o genérico ao driver: a
  restrição de tipo do `execute` do MikroORM é sobre entidade, e aqui as
  consultas são projeções soltas — `count(*)::text`, `::numeric(20,2)::text` —
  que não correspondem a entidade nenhuma.
*/
async function exec<T>(
  sql: string,
  params: readonly unknown[] = [],
): Promise<T> {
  if (db === undefined) {
    throw new Error('o banco de teste não subiu; veja a falha do beforeAll');
  }

  const rows: unknown = await db.orm.em
    .getConnection()
    .execute(sql, [...params]);

  return rows as T;
}

interface MoneyBody {
  amount: string;
  currency: string;
}

interface WalletBody {
  id: string;
  playerId: string;
  balance: MoneyBody;
  version: number;
}

async function createWallet(
  amount = '1000.00',
  currency = 'BRL',
  playerId = randomUUID(),
): Promise<WalletBody> {
  const response = await http()
    .post('/wallets')
    .send({ playerId, initialBalance: { amount, currency } })
    .expect(201);

  return response.body as WalletBody;
}

interface SubmitPayload {
  readonly providerId?: string;
  readonly externalTransactionId?: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly roundId?: string;
  readonly gameId?: string;
  readonly kind: string;
  readonly money?: MoneyBody;
  readonly referenceExternalTransactionId?: string;
}

/*
  O corpo pronto de `POST /wagering/transactions`.

  Tipado, e não `Record<string, unknown>`: com o registro genérico cada leitura
  de campo no teste viraria acesso por string e perderia a verificação — um
  `externalTransactionId` escrito errado passaria como `undefined` e o teste
  ainda assim mandaria a requisição.
*/
interface SubmitBody {
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: string;
  readonly money: MoneyBody;
  readonly referenceExternalTransactionId?: string;
}

function body(payload: SubmitPayload): SubmitBody {
  return {
    providerId: payload.providerId ?? 'provider-a',
    externalTransactionId: payload.externalTransactionId ?? randomUUID(),
    playerId: payload.playerId,
    walletId: payload.walletId,
    roundId: payload.roundId ?? 'round-987',
    gameId: payload.gameId ?? 'fortune-chimp',
    kind: payload.kind,
    money: payload.money ?? { amount: '25.00', currency: 'BRL' },
    ...(payload.referenceExternalTransactionId === undefined
      ? {}
      : {
          referenceExternalTransactionId:
            payload.referenceExternalTransactionId,
        }),
  };
}

function submit(payload: SubmitBody, idempotencyKey: string): request.Test {
  return http()
    .post('/wagering/transactions')
    .set('Idempotency-Key', idempotencyKey)
    .send(payload);
}

function keyFor(payload: SubmitBody): string {
  return `${payload.providerId}:${payload.externalTransactionId}`;
}

// Submete derivando a chave de idempotência do payload.
function submitNew(payload: SubmitBody): request.Test {
  return submit(payload, keyFor(payload));
}

/*
  Saldo igual à soma com sinal do ledger.

  Conferida contra o banco, não contra a resposta: é a divergência entre saldo
  materializado e ledger que o sistema inteiro existe para impedir, e ela só
  aparece olhando as duas tabelas.
*/
async function expectInvariant(walletId: string): Promise<void> {
  const rows = await exec<{ stored: string; calculated: string }[]>(
    /*
      O `::numeric(20,2)` no coalesce não é enfeite: sem ele, a soma vazia
      volta como `0` e o saldo como `0.00`, e a comparação de texto falharia
      por diferença de escala e não de valor. Comparar na mesma escala da
      coluna é o que faz a asserção ser sobre dinheiro.
    */
    `select w.balance_amount::text as stored,
            coalesce(sum(
              case e.direction when 'CREDIT' then e.money_amount
                               else -e.money_amount end
            ), 0)::numeric(20,2)::text as calculated
       from wallets w
       left join wallet_ledger_entries e on e.wallet_id = w.id
      where w.id = ?
      group by w.balance_amount`,
    [walletId],
  );

  /*
    A linha **tem** de existir. Sem esta asserção, uma consulta que não acha
    nada compararia `undefined` com `undefined` e o teste passaria vazio — o
    pior tipo de teste verde, porque dá confiança sem verificar nada. Foi
    exatamente o que aconteceu enquanto a aplicação apontava para outro banco.
  */
  expect(rows).toHaveLength(1);
  expect(rows[0]?.stored).toBe(rows[0]?.calculated);
}

async function eventTypesFor(walletId: string): Promise<string[]> {
  const rows = await exec<{ event_type: string }[]>(
    `select event_type from outbox_messages
      where aggregate_id = ? order by occurred_at, id`,
    [walletId],
  );

  return rows.map((row) => row.event_type);
}

beforeAll(async () => {
  db = await createTestDatabase('api');

  previousDatabase = process.env.POSTGRES_DB;
  process.env.POSTGRES_DB = db.name;

  /*
    Os módulos são importados **dinamicamente**, e isto não é estilo: é o
    único jeito de o teste apontar para o banco descartável.

    `NestConfigModule.forRoot({...})` é chamado na avaliação do decorator do
    `ConfigModule`, isto é, no instante em que o arquivo é **importado** — e
    não quando o módulo é compilado. Com `import` estático no topo, o ambiente
    é capturado antes de `beforeAll` rodar, e a aplicação sobe no banco de
    desenvolvimento. Foi o que aconteceu na primeira versão deste arquivo: as
    respostas HTTP estavam todas corretas, e as conferências em SQL voltavam
    vazias porque liam outro banco.

    Importar depois de ajustar `process.env` faz o teste exercitar o caminho
    **real** de configuração, sem substituir `EnvService` nem o módulo de
    persistência por dublê nenhum.
  */
  const [
    { ConfigModule },
    { PersistenceModule },
    { ApiModule },
    { ObservabilityModule },
  ] = await Promise.all([
    import('../../src/config/config.module'),
    import('../../src/infrastructure/persistence/persistence.module'),
    import('../../src/interfaces/http/api.module'),
    import('../../src/interfaces/http/observability/observability.module'),
  ]);

  const moduleRef = await Test.createTestingModule({
    imports: [ConfigModule, PersistenceModule, ApiModule, ObservabilityModule],
  }).compile();

  app = moduleRef.createNestApplication();
  await app.init();

  /*
    Guarda contra o erro acima voltar em silêncio.

    Cria uma wallet pela API e confirma que ela é visível pela conexão de
    conferência. Comparar `current_database()` não serviria: isso diria onde a
    **conferência** está, não onde a aplicação está. O que importa é que as
    duas pontas vejam a mesma coisa — sem isso, este arquivo passa verde sem
    verificar nada do que diz verificar.
  */
  const probe = await createWallet('1.00');
  const visible = await exec<{ count: string }[]>(
    'select count(*)::text as count from wallets where id = ?',
    [probe.id],
  );
  expect(visible[0]?.count).toBe('1');
}, 180_000);

afterAll(async () => {
  /*
    Guardas porque `afterAll` roda mesmo quando `beforeAll` falhou no meio.
    Sem elas, um `TypeError: undefined is not an object` aqui aparece no lugar
    do erro de verdade — foi o que escondeu um `ECONNREFUSED` do PostgreSQL.
  */
  if (app !== undefined) await app.close();
  if (db !== undefined) await db.close();

  if (previousDatabase === undefined) {
    delete process.env.POSTGRES_DB;
  } else {
    process.env.POSTGRES_DB = previousDatabase;
  }
});

describe('POST /wallets', () => {
  it('devolve exatamente os campos do contrato de resposta', async () => {
    const playerId = randomUUID();

    const response = await http()
      .post('/wallets')
      .send({
        playerId,
        initialBalance: { amount: '1000.00', currency: 'BRL' },
      })
      .expect(201);

    expect(response.body).toEqual({
      id: expect.any(String) as unknown as string,
      playerId,
      balance: { amount: '1000.00', currency: 'BRL' },
      version: 1,
    });
  });

  it('abre com version 1 mesmo com saldo positivo', async () => {
    /*
      O contrato é explícito. O crédito de abertura faz parte da
      criação, e não conta como "o saldo mudou".
    */
    const wallet = await createWallet('1000.00');
    expect(wallet.version).toBe(1);
  });

  it('gera transação OPENING e lançamento no mesmo commit', async () => {
    const wallet = await createWallet('1000.00');

    const rows = await exec<{ kind: string; status: string }[]>(
      `select kind, status from wager_transactions where wallet_id = ?`,
      [wallet.id],
    );
    expect(rows).toEqual([{ kind: 'OPENING', status: 'PROCESSED' }]);

    const entries = await exec<{ direction: string; amount: string }[]>(
      `select direction, money_amount::text as amount
         from wallet_ledger_entries where wallet_id = ?`,
      [wallet.id],
    );
    expect(entries).toEqual([{ direction: 'CREDIT', amount: '1000.00' }]);

    await expectInvariant(wallet.id);
  });

  it('não gera transação nem lançamento com saldo inicial zero', async () => {
    const wallet = await createWallet('0.00');

    const rows = await exec<{ count: string }[]>(
      `select count(*)::text as count from wager_transactions where wallet_id = ?`,
      [wallet.id],
    );
    expect(rows[0]?.count).toBe('0');
    await expectInvariant(wallet.id);
  });

  it('normaliza a escala do saldo inicial', async () => {
    expect((await createWallet('1000')).balance.amount).toBe('1000.00');
    expect((await createWallet('25.5')).balance.amount).toBe('25.50');
  });

  it('recusa wallet duplicada para player e moeda', async () => {
    const playerId = randomUUID();
    await createWallet('10.00', 'BRL', playerId);

    const response = await http()
      .post('/wallets')
      .send({ playerId, initialBalance: { amount: '99.00', currency: 'BRL' } })
      .expect(409);

    expect(response.body).toMatchObject({
      failureCode: 'WALLET_ALREADY_EXISTS',
    });
  });

  it('aceita o mesmo player em moedas diferentes', async () => {
    const playerId = randomUUID();
    await createWallet('10.00', 'BRL', playerId);

    const usd = await createWallet('10.00', 'USD', playerId);
    expect(usd.balance.currency).toBe('USD');
  });

  it('recusa saldo inicial negativo com 400 e aponta o campo', async () => {
    const response = await http()
      .post('/wallets')
      .send({
        playerId: randomUUID(),
        initialBalance: { amount: '-1.00', currency: 'BRL' },
      })
      .expect(400);

    expect(response.body).toMatchObject({ failureCode: 'VALIDATION_FAILED' });
    expect(JSON.stringify(response.body)).toContain('initialBalance');
  });

  it('recusa valor com três casas decimais', async () => {
    await http()
      .post('/wallets')
      .send({
        playerId: randomUUID(),
        initialBalance: { amount: '10.001', currency: 'BRL' },
      })
      .expect(400);
  });

  it('recusa número JSON onde o contrato pede string', async () => {
    await http()
      .post('/wallets')
      .send({
        playerId: randomUUID(),
        initialBalance: { amount: 10.5, currency: 'BRL' },
      })
      .expect(400);
  });
});

describe('GET /wallets/:walletId', () => {
  it('devolve o corpo da wallet', async () => {
    const created = await createWallet('500.00');

    const response = await http().get(`/wallets/${created.id}`).expect(200);
    expect(response.body).toEqual(created);
  });

  it('404 para wallet inexistente', async () => {
    const response = await http().get(`/wallets/${randomUUID()}`).expect(404);

    expect(response.body).toMatchObject({ failureCode: 'WALLET_NOT_FOUND' });
  });
});

describe('POST /wagering/transactions — BET', () => {
  it('debita e devolve o corpo completo da resposta', async () => {
    const wallet = await createWallet('1000.00');
    const payload = body({
      playerId: wallet.playerId,
      walletId: wallet.id,
      kind: 'BET',
    });

    const response = await submitNew(payload).expect(200);

    expect(response.body).toEqual({
      transactionId: expect.any(String) as unknown as string,
      status: 'PROCESSED',
      balance: { amount: '975.00', currency: 'BRL' },
      idempotentReplay: false,
    });
    await expectInvariant(wallet.id);
  });

  it('exige o header Idempotency-Key', async () => {
    const wallet = await createWallet('100.00');

    const response = await http()
      .post('/wagering/transactions')
      .send(
        body({ playerId: wallet.playerId, walletId: wallet.id, kind: 'BET' }),
      )
      .expect(400);

    expect(response.body).toMatchObject({ failureCode: 'VALIDATION_FAILED' });
    expect(String((response.body as { message?: string }).message)).toContain(
      'Idempotency-Key',
    );
  });

  it('recusa aposta sem saldo com 422, e deixa o saldo intacto', async () => {
    const wallet = await createWallet('10.00');
    const payload = body({
      playerId: wallet.playerId,
      walletId: wallet.id,
      kind: 'BET',
      money: { amount: '80.00', currency: 'BRL' },
    });

    const response = await submitNew(payload).expect(422);

    expect(response.body).toMatchObject({
      status: 'REJECTED',
      failureCode: 'INSUFFICIENT_FUNDS',
      balance: { amount: '10.00', currency: 'BRL' },
    });

    // Regra 6: recusa não altera saldo nem gera ledger — e continua auditável.
    const reread = await http().get(`/wallets/${wallet.id}`).expect(200);
    expect((reread.body as WalletBody).balance.amount).toBe('10.00');
    expect((reread.body as WalletBody).version).toBe(1);
    await expectInvariant(wallet.id);
  });

  it('404 para wallet inexistente, sem persistir transação', async () => {
    const payload = body({
      playerId: randomUUID(),
      walletId: randomUUID(),
      kind: 'BET',
    });

    const response = await submitNew(payload).expect(404);
    expect(response.body).toMatchObject({ failureCode: 'WALLET_NOT_FOUND' });
  });

  it('422 quando a moeda difere da wallet', async () => {
    const wallet = await createWallet('100.00', 'BRL');
    const payload = body({
      playerId: wallet.playerId,
      walletId: wallet.id,
      kind: 'BET',
      money: { amount: '10.00', currency: 'USD' },
    });

    const response = await submitNew(payload).expect(422);
    expect(response.body).toMatchObject({ failureCode: 'CURRENCY_MISMATCH' });
  });

  it('400 quando o player não é o dono da wallet', async () => {
    const wallet = await createWallet('100.00');
    const payload = body({
      playerId: randomUUID(),
      walletId: wallet.id,
      kind: 'BET',
    });

    const response = await submitNew(payload).expect(400);
    expect(response.body).toMatchObject({ failureCode: 'VALIDATION_FAILED' });
  });
});

describe('POST /wagering/transactions — idempotência', () => {
  it('requisição idêntica devolve a mesma resposta, com replay marcado', async () => {
    const wallet = await createWallet('1000.00');
    const payload = body({
      playerId: wallet.playerId,
      walletId: wallet.id,
      kind: 'BET',
    });
    const key = keyFor(payload);

    const first = await submit(payload, key).expect(200);
    const second = await submit(payload, key).expect(200);

    expect(second.body).toEqual({
      ...(first.body as Record<string, unknown>),
      idempotentReplay: true,
    });

    // O efeito aconteceu uma vez só.
    const entries = await exec<{ count: string }[]>(
      `select count(*)::text as count from wallet_ledger_entries
        where wallet_id = ? and direction = 'DEBIT'`,
      [wallet.id],
    );
    expect(entries[0]?.count).toBe('1');
    await expectInvariant(wallet.id);
  });

  it('o replay devolve o saldo observado naquele momento', async () => {
    // Entre a aposta e o replay entra outra operação, e o
    // replay continua respondendo o saldo de quando a transação foi aplicada.
    const wallet = await createWallet('1000.00');
    const first = body({
      playerId: wallet.playerId,
      walletId: wallet.id,
      kind: 'BET',
    });
    const key = keyFor(first);

    await submit(first, key).expect(200);

    await submitNew(
      body({ playerId: wallet.playerId, walletId: wallet.id, kind: 'BET' }),
    ).expect(200);

    const replay = await submit(first, key).expect(200);

    expect(replay.body).toMatchObject({
      balance: { amount: '975.00', currency: 'BRL' },
      idempotentReplay: true,
    });
    await expectInvariant(wallet.id);
  });

  it('mesma chave com payload divergente é conflito, não replay', async () => {
    const wallet = await createWallet('1000.00');
    const payload = body({
      playerId: wallet.playerId,
      walletId: wallet.id,
      kind: 'BET',
    });
    const key = keyFor(payload);

    await submit(payload, key).expect(200);

    const divergente = {
      ...payload,
      money: { amount: '26.00', currency: 'BRL' },
    };
    const response = await submit(divergente, key).expect(409);

    expect(response.body).toMatchObject({
      failureCode: 'IDEMPOTENCY_CONFLICT',
    });
  });

  it('formatação diferente do mesmo valor é replay, não conflito', async () => {
    // O hash é sobre o valor de domínio, não sobre o texto cru: um provedor
    // que reenvia "25" onde mandou "25.00" está repetindo a mesma operação.
    const wallet = await createWallet('1000.00');
    const payload = body({
      playerId: wallet.playerId,
      walletId: wallet.id,
      kind: 'BET',
    });
    const key = keyFor(payload);

    await submit(payload, key).expect(200);

    const response = await submit(
      { ...payload, money: { amount: '25', currency: 'BRL' } },
      key,
    ).expect(200);

    expect(response.body).toMatchObject({ idempotentReplay: true });
  });

  it('mesma transação do provedor com outra chave é conflito', async () => {
    const wallet = await createWallet('1000.00');
    const payload = body({
      playerId: wallet.playerId,
      walletId: wallet.id,
      kind: 'BET',
    });

    await submit(payload, keyFor(payload)).expect(200);

    const response = await submit(
      payload,
      `outra-chave-${randomUUID()}`,
    ).expect(409);
    expect(response.body).toMatchObject({
      failureCode: 'IDEMPOTENCY_CONFLICT',
    });
  });
});

describe('POST /wagering/transactions — WIN e LOSS', () => {
  it('WIN credita', async () => {
    const wallet = await createWallet('100.00');

    const response = await submitNew(
      body({
        playerId: wallet.playerId,
        walletId: wallet.id,
        kind: 'WIN',
        money: { amount: '40.00', currency: 'BRL' },
      }),
    ).expect(200);

    expect(response.body).toMatchObject({
      status: 'PROCESSED',
      balance: { amount: '140.00', currency: 'BRL' },
    });
    await expectInvariant(wallet.id);
  });

  it('LOSS registra sem mover saldo nem gerar lançamento', async () => {
    const wallet = await createWallet('100.00');

    const response = await submitNew(
      body({ playerId: wallet.playerId, walletId: wallet.id, kind: 'LOSS' }),
    ).expect(200);

    expect(response.body).toMatchObject({
      status: 'PROCESSED',
      balance: { amount: '100.00', currency: 'BRL' },
    });

    const entries = await exec<{ count: string }[]>(
      `select count(*)::text as count from wallet_ledger_entries
        where wallet_id = ? and transaction_id = ?`,
      [wallet.id, (response.body as { transactionId: string }).transactionId],
    );
    expect(entries[0]?.count).toBe('0');
    await expectInvariant(wallet.id);
  });

  it('LOSS publica WagerTransactionProcessed e não WalletBalanceChanged', async () => {
    // `WagerTransactionProcessed` sai inclusive para `LOSS`;
    // `WalletBalanceChanged` sai somente quando o saldo muda.
    const wallet = await createWallet('0.00');

    await submitNew(
      body({ playerId: wallet.playerId, walletId: wallet.id, kind: 'LOSS' }),
    ).expect(200);

    expect(await eventTypesFor(wallet.id)).toEqual([
      'WagerTransactionProcessed',
    ]);
  });
});

describe('POST /wagering/transactions — reversões', () => {
  async function processedBet(
    wallet: WalletBody,
    amount = '25.00',
  ): Promise<string> {
    const payload = body({
      playerId: wallet.playerId,
      walletId: wallet.id,
      kind: 'BET',
      money: { amount, currency: 'BRL' },
    });
    await submitNew(payload).expect(200);
    return payload.externalTransactionId;
  }

  function reversal(
    wallet: WalletBody,
    kind: 'REFUND' | 'ROLLBACK',
    reference: string,
    amount = '25.00',
  ): SubmitBody {
    return body({
      playerId: wallet.playerId,
      walletId: wallet.id,
      kind,
      money: { amount, currency: 'BRL' },
      referenceExternalTransactionId: reference,
    });
  }

  it('REFUND de BET processada credita de volta', async () => {
    const wallet = await createWallet('100.00');
    const reference = await processedBet(wallet);

    const response = await submitNew(
      reversal(wallet, 'REFUND', reference),
    ).expect(200);

    expect(response.body).toMatchObject({
      status: 'PROCESSED',
      balance: { amount: '100.00', currency: 'BRL' },
    });
    await expectInvariant(wallet.id);
  });

  it('a mesma referência não é revertida duas vezes pelo mesmo tipo', async () => {
    const wallet = await createWallet('100.00');
    const reference = await processedBet(wallet);

    await submitNew(reversal(wallet, 'REFUND', reference)).expect(200);

    const response = await submitNew(
      reversal(wallet, 'REFUND', reference),
    ).expect(422);

    expect(response.body).toMatchObject({
      status: 'REJECTED',
      failureCode: 'ALREADY_REVERSED',
    });
    // A tentativa recusada ficou auditável, e o saldo não mudou.
    expect(response.body).toHaveProperty('transactionId');
    await expectInvariant(wallet.id);
  });

  it('REFUND com valor diferente da referência é recusado', async () => {
    const wallet = await createWallet('100.00');
    const reference = await processedBet(wallet, '25.00');

    const response = await submitNew(
      reversal(wallet, 'REFUND', reference, '10.00'),
    ).expect(422);

    expect(response.body).toMatchObject({ failureCode: 'AMOUNT_MISMATCH' });
  });

  it('REFUND de WIN é recusado pelo tipo', async () => {
    const wallet = await createWallet('100.00');
    const win = body({
      playerId: wallet.playerId,
      walletId: wallet.id,
      kind: 'WIN',
      money: { amount: '25.00', currency: 'BRL' },
    });
    await submitNew(win).expect(200);

    const response = await submitNew(
      reversal(wallet, 'REFUND', win.externalTransactionId),
    ).expect(422);

    expect(response.body).toMatchObject({
      failureCode: 'REFERENCE_KIND_INVALID',
    });
  });

  it('referência ausente responde 202 e agenda reprocessamento', async () => {
    const wallet = await createWallet('100.00');

    const response = await submitNew(
      reversal(wallet, 'REFUND', `inexistente-${randomUUID()}`),
    ).expect(202);

    expect(response.body).toMatchObject({ status: 'PENDING_REFERENCE' });

    const transactionId = (response.body as { transactionId: string })
      .transactionId;
    const detail = await http()
      .get(`/wagering/transactions/${transactionId}`)
      .expect(200);

    expect(detail.body).toMatchObject({
      status: 'PENDING_REFERENCE',
      referenceAttempts: 1,
    });
    expect(detail.body).toHaveProperty('nextReferenceAttemptAt');
    await expectInvariant(wallet.id);
  });

  it('ROLLBACK de WIN debita, invertendo o crédito original', async () => {
    const wallet = await createWallet('100.00');
    const win = body({
      playerId: wallet.playerId,
      walletId: wallet.id,
      kind: 'WIN',
      money: { amount: '40.00', currency: 'BRL' },
    });
    await submitNew(win).expect(200);

    const response = await submitNew(
      reversal(wallet, 'ROLLBACK', win.externalTransactionId, '40.00'),
    ).expect(200);

    expect(response.body).toMatchObject({
      status: 'PROCESSED',
      balance: { amount: '100.00', currency: 'BRL' },
    });
    await expectInvariant(wallet.id);
  });

  it('ROLLBACK que estouraria o saldo tem código próprio', async () => {
    // Distinto de INSUFFICIENT_FUNDS, porque indica que
    // provedor e plataforma divergem sobre o estado.
    const wallet = await createWallet('0.00');
    const win = body({
      playerId: wallet.playerId,
      walletId: wallet.id,
      kind: 'WIN',
      money: { amount: '50.00', currency: 'BRL' },
    });
    await submitNew(win).expect(200);

    // Gasta o crédito, de modo que a reversão não cabe mais.
    await submitNew(
      body({
        playerId: wallet.playerId,
        walletId: wallet.id,
        kind: 'BET',
        money: { amount: '50.00', currency: 'BRL' },
      }),
    ).expect(200);

    const response = await submitNew(
      reversal(wallet, 'ROLLBACK', win.externalTransactionId, '50.00'),
    ).expect(422);

    expect(response.body).toMatchObject({
      status: 'REJECTED',
      failureCode: 'REVERSAL_WOULD_OVERDRAW',
    });
    await expectInvariant(wallet.id);
  });
});

describe('outbox no mesmo commit', () => {
  it('a aposta aplicada deixa os dois eventos de saldo na outbox', async () => {
    const wallet = await createWallet('100.00');

    await submitNew(
      body({ playerId: wallet.playerId, walletId: wallet.id, kind: 'BET' }),
    ).expect(200);

    // Abertura mais aposta: dois `Processed` e dois `BalanceChanged`.
    const events = await eventTypesFor(wallet.id);
    expect(
      events.filter((type) => type === 'WagerTransactionProcessed'),
    ).toHaveLength(2);
    expect(
      events.filter((type) => type === 'WalletBalanceChanged'),
    ).toHaveLength(2);
  });

  it('a recusa deixa WagerTransactionRejected na outbox', async () => {
    const wallet = await createWallet('1.00');

    await submitNew(
      body({
        playerId: wallet.playerId,
        walletId: wallet.id,
        kind: 'BET',
        money: { amount: '80.00', currency: 'BRL' },
      }),
    ).expect(422);

    expect(await eventTypesFor(wallet.id)).toContain(
      'WagerTransactionRejected',
    );
  });

  it('a espera por referência deixa o evento correspondente', async () => {
    const wallet = await createWallet('0.00');

    await submitNew(
      body({
        playerId: wallet.playerId,
        walletId: wallet.id,
        kind: 'REFUND',
        referenceExternalTransactionId: `inexistente-${randomUUID()}`,
      }),
    ).expect(202);

    expect(await eventTypesFor(wallet.id)).toEqual([
      'WagerTransactionPendingReference',
    ]);
  });

  it('nada vai para a outbox quando a recusa é anterior à transação', async () => {
    // Wallet inexistente não produz transação nem evento: não houve operação.
    const walletId = randomUUID();

    await submitNew(
      body({ playerId: randomUUID(), walletId, kind: 'BET' }),
    ).expect(404);

    expect(await eventTypesFor(walletId)).toEqual([]);
  });

  it('o envelope gravado carrega dinheiro como string decimal', async () => {
    const wallet = await createWallet('100.00');

    await submitNew(
      body({ playerId: wallet.playerId, walletId: wallet.id, kind: 'BET' }),
    ).expect(200);

    const rows = await exec<{ payload: Record<string, unknown> }[]>(
      `select payload from outbox_messages
        where aggregate_id = ? and event_type = 'WalletBalanceChanged'
        order by occurred_at desc, id desc limit 1`,
      [wallet.id],
    );

    const payload = rows[0]?.payload as
      { data?: { money?: MoneyBody } } | undefined;

    expect(payload?.data?.money).toEqual({ amount: '25.00', currency: 'BRL' });
  });
});

describe('GET das transações', () => {
  it('encontra pelo id interno e pela chave do provedor', async () => {
    const wallet = await createWallet('100.00');
    const payload = body({
      playerId: wallet.playerId,
      walletId: wallet.id,
      kind: 'BET',
    });
    const submitted = await submitNew(payload).expect(200);
    const transactionId = (submitted.body as { transactionId: string })
      .transactionId;

    const byId = await http()
      .get(`/wagering/transactions/${transactionId}`)
      .expect(200);
    expect(byId.body).toMatchObject({
      transactionId,
      kind: 'BET',
      status: 'PROCESSED',
      money: { amount: '25.00', currency: 'BRL' },
      observedBalance: { amount: '75.00', currency: 'BRL' },
    });

    const byProvider = await http()
      .get(
        `/providers/provider-a/wagering/transactions/${payload.externalTransactionId}`,
      )
      .expect(200);
    expect(byProvider.body).toEqual(byId.body);
  });

  it('404 para id interno desconhecido', async () => {
    const response = await http()
      .get(`/wagering/transactions/${randomUUID()}`)
      .expect(404);

    expect(response.body).toMatchObject({
      failureCode: 'TRANSACTION_NOT_FOUND',
    });
  });

  it('404 para chave de provedor desconhecida', async () => {
    const response = await http()
      .get('/providers/provider-a/wagering/transactions/nao-existe')
      .expect(404);

    expect(response.body).toMatchObject({
      failureCode: 'TRANSACTION_NOT_FOUND',
    });
  });
});

describe('GET /wallets/:walletId/ledger', () => {
  async function walletWithEntries(count: number): Promise<WalletBody> {
    const wallet = await createWallet('1000.00');

    for (let index = 0; index < count; index += 1) {
      await submitNew(
        body({
          playerId: wallet.playerId,
          walletId: wallet.id,
          kind: 'BET',
          money: { amount: '1.00', currency: 'BRL' },
        }),
      ).expect(200);
    }

    return wallet;
  }

  it('devolve os lançamentos em ordem', async () => {
    const wallet = await walletWithEntries(2);

    const response = await http()
      .get(`/wallets/${wallet.id}/ledger`)
      .expect(200);

    const entries = (response.body as { entries: { direction: string }[] })
      .entries;
    expect(entries).toHaveLength(3);
    expect(entries[0]?.direction).toBe('CREDIT');
    expect(entries[1]?.direction).toBe('DEBIT');
    expect(response.body).not.toHaveProperty('nextCursor');
  });

  it('pagina com cursor opaco, sem repetir nem pular', async () => {
    const wallet = await walletWithEntries(4);
    const seen: string[] = [];
    let cursor: string | undefined;

    for (let page = 0; page < 5; page += 1) {
      const response = await http()
        .get(`/wallets/${wallet.id}/ledger`)
        .query({ limit: 2, ...(cursor === undefined ? {} : { cursor }) })
        .expect(200);

      const payload = response.body as {
        entries: { id: string }[];
        nextCursor?: string;
      };
      seen.push(...payload.entries.map((entry) => entry.id));

      cursor = payload.nextCursor;
      if (cursor === undefined) break;
    }

    // Abertura mais quatro apostas, cada id uma vez só.
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    expect(cursor).toBeUndefined();
  });

  it('recusa cursor ilegível em vez de voltar ao começo', async () => {
    const wallet = await createWallet('10.00');

    const response = await http()
      .get(`/wallets/${wallet.id}/ledger`)
      .query({ cursor: 'nao-e-cursor' })
      .expect(400);

    expect(response.body).toMatchObject({ failureCode: 'VALIDATION_FAILED' });
  });

  it('recusa limit acima do teto', async () => {
    const wallet = await createWallet('10.00');

    await http()
      .get(`/wallets/${wallet.id}/ledger`)
      .query({ limit: 201 })
      .expect(400);
  });

  it('404 para wallet inexistente, em vez de página vazia', async () => {
    await http().get(`/wallets/${randomUUID()}/ledger`).expect(404);
  });
});

describe('POST /wallets/:walletId/reconciliation', () => {
  it('devolve exatamente os campos do contrato de reconciliação', async () => {
    const wallet = await createWallet('1000.00');
    await submitNew(
      body({ playerId: wallet.playerId, walletId: wallet.id, kind: 'BET' }),
    ).expect(200);

    const response = await http()
      .post(`/wallets/${wallet.id}/reconciliation`)
      .expect(200);

    expect(response.body).toEqual({
      walletId: wallet.id,
      storedBalance: { amount: '975.00', currency: 'BRL' },
      calculatedBalance: { amount: '975.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 2,
    });
  });

  it('detecta divergência e NÃO a corrige', async () => {
    // O saldo é adulterado por fora, o que o ledger não permite: o trigger
    // recusa update no ledger, mas a coluna da wallet é gravável. É exatamente
    // o cenário que a reconciliação existe para encontrar.
    const wallet = await createWallet('100.00');
    await exec(`update wallets set balance_amount = '999.00' where id = ?`, [
      wallet.id,
    ]);

    const response = await http()
      .post(`/wallets/${wallet.id}/reconciliation`)
      .expect(200);

    expect(response.body).toMatchObject({
      storedBalance: { amount: '999.00', currency: 'BRL' },
      calculatedBalance: { amount: '100.00', currency: 'BRL' },
      difference: { amount: '899.00', currency: 'BRL' },
      consistent: false,
      checkedEntries: 1,
    });

    // E continua divergente depois: nada foi corrigido em silêncio.
    const reread = await exec<{ amount: string }[]>(
      `select balance_amount::text as amount from wallets where id = ?`,
      [wallet.id],
    );
    expect(reread[0]?.amount).toBe('999.00');
  });

  it('404 para wallet inexistente', async () => {
    await http().post(`/wallets/${randomUUID()}/reconciliation`).expect(404);
  });
});

describe('GET /metrics', () => {
  it('responde 200 em texto Prometheus', async () => {
    const response = await http().get('/metrics').expect(200);

    expect(response.headers['content-type']).toContain('version=0.0.4');
    // Instantâneo não se guarda em cache; métrica cacheada é métrica errada.
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('declara toda métrica do catálogo, com HELP e TYPE', async () => {
    const { METRICS_CATALOG } =
      await import('../../src/application/ports/metrics.port');
    const response = await http().get('/metrics').expect(200);
    const text = response.text;

    for (const declaration of METRICS_CATALOG) {
      expect(text).toContain(`# HELP ${declaration.name} `);
      expect(text).toContain(`# TYPE ${declaration.name} ${declaration.kind}`);
    }
  });

  it('expõe a mesma instância que os casos de uso alimentam', async () => {
    /*
      `METRICS` e `METRICS_EXPOSITION` apontam para o mesmo registry. Com
      duas instâncias, este endpoint responderia zero para sempre e o bug
      não daria sinal nenhum — por isso a conferência é por identidade de
      objeto, e não por valor exposto.
    */
    const { METRICS, METRICS_EXPOSITION } =
      await import('../../src/application/ports/metrics.port');

    if (app === undefined) {
      throw new Error('a aplicação não subiu; veja a falha do beforeAll');
    }

    expect(app.get(METRICS)).toBe(app.get(METRICS_EXPOSITION));
  });

  it('não expõe autenticação, como os health checks', async () => {
    // Um coletor não carrega credencial de provedor.
    await http().get('/metrics').expect(200);
  });
});
