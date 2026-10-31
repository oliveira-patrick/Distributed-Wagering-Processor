/*
  Cenário de concorrência: banco e filas descartáveis, e instâncias de
  verdade em cima deles.

  Tudo aqui conversa com a aplicação por **HTTP** e confere o resultado em
  **SQL cru**, por fora do domínio. É deliberado: o que estas suítes afirmam
  é sobre o estado final no PostgreSQL, e lê-lo pelos próprios repositórios
  usaria o código sob teste para julgar o código sob teste.
*/
import { randomUUID } from 'node:crypto';

import { MikroORM } from '@mikro-orm/postgresql';

import { createTestDatabase } from '../../integration/support/test-database';
import type { TestDatabase } from '../../integration/support/test-database';
import { createTestQueues } from '../../integration/support/test-queues';
import type { TestQueues } from '../../integration/support/test-queues';
import { spawnInstance, terminateAll } from './instances';
import type { SpawnedInstance } from './instances';

export interface MoneyBody {
  readonly amount: string;
  readonly currency: string;
}

export interface WalletBody {
  readonly id: string;
  readonly playerId: string;
  readonly balance: MoneyBody;
  readonly version: number;
}

export interface SubmitResponse {
  readonly status: number;
  readonly body: {
    readonly transactionId?: string;
    readonly status?: string;
    readonly balance?: MoneyBody;
    readonly idempotentReplay?: boolean;
    readonly failureCode?: string;
  };
}

export interface LedgerRow {
  readonly direction: string;
  readonly amount: string;
  readonly before: string;
  readonly after: string;
}

export interface HarnessOptions {
  // Sufixo do banco e das filas; um por arquivo de teste.
  readonly suffix: string;
  readonly apiInstances?: number;
  readonly workerInstances?: number;
  readonly apiEnv?: Readonly<Record<string, string>>;
  readonly workerEnv?: Readonly<Record<string, string>>;
}

export class Harness {
  private constructor(
    readonly db: TestDatabase,
    readonly queues: TestQueues,
    readonly apis: SpawnedInstance[],
    readonly workers: SpawnedInstance[],
  ) {}

  static async start(options: HarnessOptions): Promise<Harness> {
    const db = await createTestDatabase(options.suffix);
    const queues = await createTestQueues(options.suffix);

    const spawn = async (
      role: 'api' | 'worker',
      count: number,
      env?: Readonly<Record<string, string>>,
    ): Promise<SpawnedInstance[]> =>
      Promise.all(
        Array.from({ length: count }, () =>
          spawnInstance({
            role,
            databaseName: db.name,
            queues,
            ...(env === undefined ? {} : { env }),
          }),
        ),
      );

    const apis = await spawn('api', options.apiInstances ?? 0, options.apiEnv);
    const workers = await spawn(
      'worker',
      options.workerInstances ?? 0,
      options.workerEnv,
    );

    return new Harness(db, queues, apis, workers);
  }

  async destroy(): Promise<void> {
    await terminateAll([...this.apis, ...this.workers]);
    await this.queues.destroy();
    await this.db.close();
  }

  // A instância de índice `i`, circulando — espalha a carga pelas réplicas.
  api(index: number): SpawnedInstance {
    const instance = this.apis[index % this.apis.length];
    if (instance === undefined) {
      throw new Error('nenhuma instância de API foi iniciada');
    }
    return instance;
  }

  async exec<T>(sql: string, params: readonly unknown[] = []): Promise<T> {
    const rows: unknown = await this.db.orm.em
      .getConnection()
      .execute(sql, [...params]);
    return rows as T;
  }

  // Uma conexão nova, para quando o teste precisa de sessão própria.
  async openConnection(): Promise<MikroORM> {
    const { buildMikroOrmConfig } =
      await import('../../../src/infrastructure/persistence/mikro-orm.config');
    return MikroORM.init(
      buildMikroOrmConfig(
        {
          host: process.env.POSTGRES_HOST ?? 'localhost',
          port: Number(process.env.POSTGRES_PORT ?? '5433'),
          user: process.env.POSTGRES_USER ?? 'wagering',
          password: process.env.POSTGRES_PASSWORD ?? 'wagering',
          database: this.db.name,
        },
        { debug: false },
      ),
    );
  }

  async createWallet(amount = '1000.00'): Promise<WalletBody> {
    const playerId = randomUUID();
    const response = await fetch(`${this.api(0).baseUrl}/wallets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        playerId,
        initialBalance: { amount, currency: 'BRL' },
      }),
    });

    if (response.status !== 201) {
      throw new Error(
        `POST /wallets devolveu ${String(response.status)}: ` +
          (await response.text()),
      );
    }

    return (await response.json()) as WalletBody;
  }

  /*
    Submete uma transação, numa instância escolhida pelo índice.

    Nunca lança por status de erro: o que os testes afirmam é justamente
    que uma das tentativas é recusada, e uma exceção aí esconderia o
    desfecho que se quer medir.
  */
  async submit(
    instanceIndex: number,
    payload: {
      readonly playerId: string;
      readonly walletId: string;
      readonly kind: string;
      readonly amount: string;
      readonly externalTransactionId?: string;
      readonly roundId?: string;
      readonly referenceExternalTransactionId?: string;
    },
    idempotencyKey?: string,
  ): Promise<SubmitResponse> {
    const externalTransactionId = payload.externalTransactionId ?? randomUUID();
    const key = idempotencyKey ?? `provider-a:${externalTransactionId}`;

    const response = await fetch(
      `${this.api(instanceIndex).baseUrl}/wagering/transactions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': key,
        },
        body: JSON.stringify({
          providerId: 'provider-a',
          externalTransactionId,
          playerId: payload.playerId,
          walletId: payload.walletId,
          roundId: payload.roundId ?? 'round-987',
          gameId: 'fortune-chimp',
          kind: payload.kind,
          money: { amount: payload.amount, currency: 'BRL' },
          ...(payload.referenceExternalTransactionId === undefined
            ? {}
            : {
                referenceExternalTransactionId:
                  payload.referenceExternalTransactionId,
              }),
        }),
      },
    );

    return {
      status: response.status,
      body: (await response.json()) as SubmitResponse['body'],
    };
  }

  async balanceOf(walletId: string): Promise<string> {
    const rows = await this.exec<{ amount: string }[]>(
      'select balance_amount::text as amount from wallets where id = ?',
      [walletId],
    );
    const amount = rows[0]?.amount;
    if (amount === undefined) {
      throw new Error(`wallet ${walletId} não existe`);
    }
    return amount;
  }

  async versionOf(walletId: string): Promise<number> {
    const rows = await this.exec<{ version: number }[]>(
      'select version from wallets where id = ?',
      [walletId],
    );
    return rows[0]?.version ?? 0;
  }

  async ledgerOf(walletId: string): Promise<LedgerRow[]> {
    return this.exec<LedgerRow[]>(
      `select direction,
              money_amount::text          as amount,
              balance_before_amount::text as before,
              balance_after_amount::text  as after
         from wallet_ledger_entries
        where wallet_id = ?
        order by created_at, id`,
      [walletId],
    );
  }

  async debitCountOf(walletId: string): Promise<number> {
    const rows = await this.exec<{ count: string }[]>(
      `select count(*)::text as count from wallet_ledger_entries
        where wallet_id = ? and direction = 'DEBIT'`,
      [walletId],
    );
    return Number(rows[0]?.count ?? '0');
  }

  async transactionStatusesOf(
    walletId: string,
  ): Promise<{ status: string; failure_code: string | null }[]> {
    return this.exec(
      `select status, failure_code from wager_transactions
        where wallet_id = ? and kind <> 'OPENING'`,
      [walletId],
    );
  }

  /*
    Saldo igual à soma com sinal do ledger, conferido em SQL.

    `wallet.balance` igual à soma com sinal do ledger. Devolve o par para que
    o teste faça a asserção e a mensagem de falha mostre os dois números.
  */
  async balanceVersusLedger(
    walletId: string,
  ): Promise<{ stored: string; rebuilt: string }> {
    const rows = await this.exec<{ stored: string; rebuilt: string }[]>(
      `select
         w.balance_amount::text as stored,
         coalesce(
           sum(
             case when e.direction = 'CREDIT'
                  then e.money_amount
                  else -e.money_amount
             end
           ),
           0
         )::numeric(20,2)::text as rebuilt
       from wallets w
       left join wallet_ledger_entries e on e.wallet_id = w.id
       where w.id = ?
       group by w.balance_amount`,
      [walletId],
    );

    const found = rows[0];
    if (found === undefined) {
      throw new Error(`wallet ${walletId} não existe`);
    }
    return found;
  }

  // Cada lançamento fecha a própria conta, e a cadeia é contínua.
  async ledgerChainOf(walletId: string): Promise<LedgerRow[]> {
    return this.ledgerOf(walletId);
  }
}

export async function waitFor<T>(
  what: string,
  probe: () => Promise<T | undefined>,
  budgetMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + budgetMs;

  for (;;) {
    const found = await probe();
    if (found !== undefined) {
      return found;
    }
    if (Date.now() >= deadline) {
      throw new Error(`${what} não aconteceu em ${String(budgetMs)} ms`);
    }
    await Bun.sleep(100);
  }
}
