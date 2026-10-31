/*
  Indisponibilidade silenciosa do SQS, contra um socket REAL.

    bun run test:integration

  Não precisa de Docker nem do emulador: o teste sobe o próprio servidor, que
  aceita a conexão e **nunca responde**. Não há dublê do SDK aqui — o cliente
  é o mesmo que a aplicação usa, a conexão TCP é de verdade, e quem termina a
  espera é o prazo configurado.

  É o cenário que o default do SDK trata pior, e de duas formas. Com
  `requestTimeout: 0`, que é o default, não há prazo nenhum. E mesmo com o
  prazo configurado, o `@smithy/node-http-handler` por padrão apenas emite um
  `[WARN]` ao estourá-lo e **deixa a requisição seguir** — só com
  `throwOnRequestTimeout: true` o estouro vira erro. Este arquivo é a guarda
  das duas coisas: um endpoint recusado falha rápido sozinho, um endpoint
  calado não falha nunca por conta própria.

  Os prazos usados aqui são curtos de propósito, para o teste terminar em
  segundos. O piso de produção — maior que o long poll — é validado no
  contrato de ambiente, em `test/unit/env.schema.spec.ts`.
*/
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { GetQueueUrlCommand } from '@aws-sdk/client-sqs';

import type { SqsTransportConfig } from '../../src/config/env.service';
import { createSqsClient } from '../../src/infrastructure/messaging/sqs.client';

const REQUEST_TIMEOUT_MS = 800;
const CONNECTION_TIMEOUT_MS = 500;

// Teto da espera aceitável: prazo, vezes as tentativas, com folga.
const BOUNDED_MS = 15_000;

let blackHole: ReturnType<typeof Bun.serve>;
let endpoint: string;

function config(
  overrides: Partial<SqsTransportConfig> = {},
): SqsTransportConfig {
  return {
    region: 'us-east-1',
    accessKeyId: 'test',
    secretAccessKey: 'test',
    endpoint,
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
    connectionTimeoutMs: CONNECTION_TIMEOUT_MS,
    ...overrides,
  };
}

// O erro de uma chamada que **deve** terminar em falha, com o tempo gasto.
async function failureOf(
  work: Promise<unknown>,
): Promise<{ error: unknown; elapsedMs: number }> {
  const started = Date.now();

  try {
    await work;
  } catch (error) {
    return { error, elapsedMs: Date.now() - started };
  }

  return { error: undefined, elapsedMs: Date.now() - started };
}

beforeAll(() => {
  blackHole = Bun.serve({
    port: 0,
    /*
      Aceita e nunca responde. A promessa jamais assenta, então a conexão
      fica aberta sem corpo de resposta.
    */
    fetch: (): Promise<Response> => new Promise<Response>(() => undefined),
  });
  endpoint = `http://127.0.0.1:${String(blackHole.port)}`;
});

afterAll(async () => {
  await blackHole.stop(true);
});

describe('endpoint que aceita a conexão e não responde', () => {
  it('a chamada termina, em vez de esperar para sempre', async () => {
    const client = createSqsClient(config());

    const { error, elapsedMs } = await failureOf(
      client.send(
        new GetQueueUrlCommand({ QueueName: 'wager-transactions.fifo' }),
      ),
    );
    client.destroy();

    expect(error).toBeDefined();
    // Medido: ~2,5 s, que é o prazo vezes as três tentativas do SDK.
    expect(elapsedMs).toBeLessThan(BOUNDED_MS);
    // E quem terminou foi o prazo do transporte, não outra falha qualquer.
    expect(String(error).toLowerCase()).toContain('timeout');
  }, 30_000);

  it('o AbortSignal de quem chama encerra antes do prazo do transporte', async () => {
    /*
      É o mecanismo do health check: o transporte tolera um long poll de 20 s,
      e a sonda de readiness não pode esperar isso. Quem precisa de prazo mais
      curto o impõe por requisição.
    */
    const client = createSqsClient(config({ requestTimeoutMs: 10_000 }));

    const { error, elapsedMs } = await failureOf(
      client.send(
        new GetQueueUrlCommand({ QueueName: 'wager-transactions.fifo' }),
        { abortSignal: AbortSignal.timeout(300) },
      ),
    );
    client.destroy();

    expect(error).toBeDefined();
    // Bem abaixo dos 10 s do transporte: quem cortou foi o sinal.
    expect(elapsedMs).toBeLessThan(5_000);
  }, 30_000);
});
