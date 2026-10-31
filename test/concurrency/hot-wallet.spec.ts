/*
  Concorrência sobre a mesma wallet, com **três instâncias de verdade**.

    bun run infra:up && bun run test:concurrency

  Três processos `bun src/main.ts` sobem contra o mesmo PostgreSQL e as
  mesmas filas descartáveis — não é `Promise.all` num processo só, que
  compartilharia pool de conexões e event loop e não provaria nada sobre
  múltiplas instâncias.

  Toda partida é dada por uma **barreira explícita**: as requisições são
  montadas, esperam um mesmo `gate`, e só então saem. `sleep` para
  "sincronizar" seria simultaneamente lento no caminho feliz e frágil numa
  máquina carregada.

  Nenhum teste aqui afirma **qual** tentativa vence. O que se afirma é o
  estado final, que é o único determinístico.
*/
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import { Harness } from './support/harness';

const INSTANCES = 3;
const SETUP_BUDGET_MS = 180_000;

let harness: Harness | undefined;

function h(): Harness {
  if (harness === undefined) {
    throw new Error('o ambiente não subiu; veja a falha do beforeAll');
  }
  return harness;
}

/*
  Dispara `count` trabalhos ao mesmo tempo.

  O `gate` é a barreira: os trabalhos são criados e ficam presos nele, então
  todos recebem a liberação no mesmo tick do event loop. Sem isso, o
  primeiro trabalho já teria terminado antes de o último ser criado, e o
  teste mediria uma fila em vez de uma disputa.
*/
async function inParallel<T>(
  count: number,
  work: (index: number) => Promise<T>,
): Promise<T[]> {
  let release!: () => void;

  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const jobs = Array.from({ length: count }, (_, index) =>
    (async (): Promise<T> => {
      await gate;
      return work(index);
    })(),
  );

  release();
  return Promise.all(jobs);
}

// Saldo igual à soma com sinal do ledger.
async function expectLedgerMatchesBalance(walletId: string): Promise<void> {
  const { stored, rebuilt } = await h().balanceVersusLedger(walletId);
  expect(stored).toBe(rebuilt);
}

/*
  A cadeia de lançamentos vai de zero ao saldo final, sem buraco.

  Independente de ordem, de propósito. Sob concorrência, vários lançamentos
  da mesma wallet caem no mesmo instante, e `order by created_at, id` não
  recupera a sequência — o `id` é um UUID aleatório, então o desempate é
  arbitrário. Ordenar e comparar vizinhos reprovava um ledger correto.

  Em vez disso: partindo de `0.00`, procura-se o lançamento cujo
  `balance_before` é o saldo atual, consome-se ele, e repete. Se todos os
  lançamentos são consumidos e o fim é o saldo da wallet, existe **um**
  caminho contínuo que os usa todos — que é a afirmação que interessa, e é
  mais forte que a comparação de vizinhos.
*/
async function expectLedgerChainIsContinuous(walletId: string): Promise<void> {
  const remaining = [...(await h().ledgerOf(walletId))];
  let current = '0.00';

  while (remaining.length > 0) {
    const next = remaining.findIndex((entry) => entry.before === current);

    if (next === -1) {
      throw new Error(
        `a cadeia do ledger quebra em ${current}: nenhum lançamento parte ` +
          `daí, e sobraram ${String(remaining.length)}`,
      );
    }

    const [step] = remaining.splice(next, 1);
    current = step?.after ?? current;
  }

  expect(current).toBe(await h().balanceOf(walletId));
}

beforeAll(async () => {
  harness = await Harness.start({
    suffix: 'hotwallet',
    apiInstances: INSTANCES,
  });
}, SETUP_BUDGET_MS);

afterAll(async () => {
  await harness?.destroy();
}, SETUP_BUDGET_MS);

describe('três instâncias simultâneas', () => {
  it('as três sobem e respondem', async () => {
    expect(h().apis).toHaveLength(INSTANCES);

    const statuses = await Promise.all(
      h().apis.map(async (instance) => {
        const response = await fetch(`${instance.baseUrl}/health/ready`);
        return response.status;
      }),
    );

    expect(statuses).toEqual([200, 200, 200]);
  });

  it('as três atendem requisições de verdade, cada uma com as suas métricas', async () => {
    const wallet = await h().createWallet('1000.00');

    // Uma aposta por instância, em paralelo, cada uma com chave própria.
    await inParallel(INSTANCES, (index) =>
      h().submit(index, {
        playerId: wallet.playerId,
        walletId: wallet.id,
        kind: 'BET',
        amount: '10.00',
      }),
    );

    /*
      A prova de que o trabalho se espalhou está no `/metrics` de cada
      processo: o registry é por processo, de propósito, então uma instância
      que não atendeu nada responde zero. Se as três mostram transação
      contada, as três trabalharam.
    */
    const counted = await Promise.all(
      h().apis.map(async (instance) => {
        const response = await fetch(`${instance.baseUrl}/metrics`);
        const text = await response.text();
        return text
          .split('\n')
          .filter(
            (line) =>
              line.startsWith('wagering_transactions_total{') &&
              line.includes('source="http"'),
          )
          .some((line) => Number(line.split(' ').at(-1)) > 0);
      }),
    );

    expect(counted).toEqual([true, true, true]);
    expect(await h().balanceOf(wallet.id)).toBe('970.00');
    await expectLedgerMatchesBalance(wallet.id);
  });
});

describe('a mesma aposta 50 vezes em paralelo', () => {
  it('produz um único débito, e 49 replays do mesmo resultado', async () => {
    const wallet = await h().createWallet('1000.00');
    const key = `provider-a:${wallet.id}-cinquenta`;

    // A **mesma** chave de idempotência, espalhada pelas três instâncias.
    const results = await inParallel(50, (index) =>
      h().submit(
        index,
        {
          playerId: wallet.playerId,
          walletId: wallet.id,
          kind: 'BET',
          amount: '40.00',
          externalTransactionId: `${wallet.id}-cinquenta`,
        },
        key,
      ),
    );

    // Todas respondem, e todas com o mesmo desfecho de negócio.
    expect(results.every((result) => result.status === 200)).toBe(true);

    const ids = new Set(results.map((result) => result.body.transactionId));
    expect(ids.size).toBe(1);

    // Exatamente uma é a original; as outras 49 são replay declarado.
    const originals = results.filter(
      (result) => result.body.idempotentReplay === false,
    );
    expect(originals).toHaveLength(1);

    // E a afirmação central: um débito só.
    expect(await h().debitCountOf(wallet.id)).toBe(1);
    expect(await h().balanceOf(wallet.id)).toBe('960.00');

    // `version` incrementa só quando o saldo muda: abertura e uma aposta.
    expect(await h().versionOf(wallet.id)).toBe(2);

    await expectLedgerMatchesBalance(wallet.id);
    await expectLedgerChainIsContinuous(wallet.id);
  });
});

describe('disputa pelo saldo da mesma wallet', () => {
  it('duas apostas de 80,00 numa wallet de 100,00: uma passa, uma é recusada', async () => {
    const wallet = await h().createWallet('100.00');

    // Chaves diferentes: são duas operações distintas disputando o saldo.
    const results = await inParallel(2, (index) =>
      h().submit(index, {
        playerId: wallet.playerId,
        walletId: wallet.id,
        kind: 'BET',
        amount: '80.00',
      }),
    );

    const processed = results.filter(
      (result) => result.body.status === 'PROCESSED',
    );
    const rejected = results.filter(
      (result) => result.body.status === 'REJECTED',
    );

    // Exatamente uma PROCESSED e exatamente uma REJECTED.
    expect(processed).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    // Recusa por regra de negócio é 422, não 409 nem 500.
    expect(rejected[0]?.status).toBe(422);
    expect(rejected[0]?.body.failureCode).toBe('INSUFFICIENT_FUNDS');

    // Saldo final 20,00.
    expect(await h().balanceOf(wallet.id)).toBe('20.00');

    // Exatamente **um** lançamento de débito. Dois seriam saldo negativo.
    expect(await h().debitCountOf(wallet.id)).toBe(1);

    // A recusa não gerou lançamento: abertura mais o débito que passou.
    expect(await h().ledgerOf(wallet.id)).toHaveLength(2);

    await expectLedgerMatchesBalance(wallet.id);
    await expectLedgerChainIsContinuous(wallet.id);
  });

  it('o saldo nunca fica negativo, com dez tentativas disputando', async () => {
    const wallet = await h().createWallet('100.00');

    // Dez apostas de 30,00 contra 100,00: no máximo três cabem.
    const results = await inParallel(10, (index) =>
      h().submit(index, {
        playerId: wallet.playerId,
        walletId: wallet.id,
        kind: 'BET',
        amount: '30.00',
      }),
    );

    const processed = results.filter(
      (result) => result.body.status === 'PROCESSED',
    );

    expect(processed).toHaveLength(3);
    expect(await h().balanceOf(wallet.id)).toBe('10.00');
    expect(await h().debitCountOf(wallet.id)).toBe(3);

    // Saldo negativo causado por race é o pior desfecho possível aqui.
    const balance = Number(await h().balanceOf(wallet.id));
    expect(balance).toBeGreaterThanOrEqual(0);

    await expectLedgerMatchesBalance(wallet.id);
    await expectLedgerChainIsContinuous(wallet.id);
  });
});

describe('wallets distintas em paralelo', () => {
  it('não se bloqueiam, e cada uma fecha a própria conta', async () => {
    const wallets = await Promise.all(
      Array.from({ length: 12 }, () => h().createWallet('500.00')),
    );

    /*
      Uma aposta por wallet, todas ao mesmo tempo, espalhadas pelas três
      instâncias. O lock é por linha, nunca global.
    */
    const results = await inParallel(wallets.length, (index) => {
      const wallet = wallets[index];
      if (wallet === undefined) {
        throw new Error('wallet ausente na montagem do teste');
      }
      return h().submit(index, {
        playerId: wallet.playerId,
        walletId: wallet.id,
        kind: 'BET',
        amount: '50.00',
      });
    });

    // Todas passam: wallets diferentes não disputam saldo.
    expect(results.every((result) => result.body.status === 'PROCESSED')).toBe(
      true,
    );

    for (const wallet of wallets) {
      expect(await h().balanceOf(wallet.id)).toBe('450.00');
      expect(await h().debitCountOf(wallet.id)).toBe(1);
      await expectLedgerMatchesBalance(wallet.id);
    }
  });

  it('uma wallet disputada não atrasa as outras até a recusa', async () => {
    const contested = await h().createWallet('50.00');
    const calm = await h().createWallet('500.00');

    // Oito tentativas na wallet apertada e oito na folgada, todas juntas.
    const results = await inParallel(16, (index) => {
      const wallet = index % 2 === 0 ? contested : calm;
      return h().submit(index, {
        playerId: wallet.playerId,
        walletId: wallet.id,
        kind: 'BET',
        amount: '40.00',
      });
    });

    expect(results).toHaveLength(16);

    // A apertada aceita uma; a folgada aceita as oito.
    expect(await h().debitCountOf(contested.id)).toBe(1);
    expect(await h().balanceOf(contested.id)).toBe('10.00');
    expect(await h().debitCountOf(calm.id)).toBe(8);
    expect(await h().balanceOf(calm.id)).toBe('180.00');

    await expectLedgerMatchesBalance(contested.id);
    await expectLedgerMatchesBalance(calm.id);
  });
});
