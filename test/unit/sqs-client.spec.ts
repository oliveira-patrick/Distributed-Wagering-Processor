/*
  Prazos do cliente SQS.

  Teste de unidade puro: nenhuma conexão é aberta. O cliente do SDK é lazy, e
  construí-lo não fala com ninguém — o que é também a razão de a aplicação
  subir com o SQS fora do ar.
*/
import { describe, expect, it } from 'bun:test';

import { MAX_LONG_POLL_SECONDS } from '../../src/config/env.schema';
import type { SqsTransportConfig } from '../../src/config/env.service';
import {
  SQS_MAX_ATTEMPTS,
  createSqsClient,
  sqsHttpOptions,
} from '../../src/infrastructure/messaging/sqs.client';

function config(
  overrides: Partial<SqsTransportConfig> = {},
): SqsTransportConfig {
  return {
    region: 'us-east-1',
    accessKeyId: 'test',
    secretAccessKey: 'test',
    endpoint: 'http://localhost:4566',
    requestTimeoutMs: 30_000,
    connectionTimeoutMs: 3_000,
    ...overrides,
  };
}

describe('sqsHttpOptions', () => {
  it('carrega os prazos vindos da configuração', () => {
    const options = sqsHttpOptions(
      config({ requestTimeoutMs: 27_000, connectionTimeoutMs: 1_500 }),
    );

    expect(options.requestTimeout).toBe(27_000);
    expect(options.connectionTimeout).toBe(1_500);
  });

  it('nunca deixa o prazo de requisição em zero', () => {
    // Zero é o default do handler do SDK, e significa **sem limite**: é
    // exatamente o comportamento que esta configuração existe para substituir.
    const options = sqsHttpOptions(config());

    expect(options.requestTimeout).toBeGreaterThan(0);
    expect(options.connectionTimeout).toBeGreaterThan(0);
  });

  it('transforma o estouro de prazo em erro, e não em aviso', () => {
    // Guarda de regressão da armadilha: por padrão o
    // `@smithy/node-http-handler` apenas emite `[WARN]` ao estourar
    // `requestTimeout` e **deixa a requisição seguir esperando**. Sem esta
    // flag, o prazo existe no código, aparece no log e não termina a chamada.
    // Medido contra um endpoint calado: 6 s depois, ainda pendurado.
    expect(sqsHttpOptions(config()).throwOnRequestTimeout).toBe(true);
  });

  it('o prazo de requisição tolera um long poll inteiro', () => {
    const options = sqsHttpOptions(config());

    expect(options.requestTimeout).toBeGreaterThan(
      MAX_LONG_POLL_SECONDS * 1_000,
    );
  });

  it('o prazo de conexão é mais curto que o de requisição', () => {
    const options = sqsHttpOptions(config());

    expect(options.connectionTimeout).toBeLessThan(options.requestTimeout);
  });
});

describe('createSqsClient', () => {
  it('constrói sem abrir conexão', () => {
    const client = createSqsClient(config());

    expect(client).toBeDefined();
    client.destroy();
  });

  it('constrói mesmo apontando para um endpoint inalcançável', () => {
    // Endpoint fora do ar não impede a construção: indisponibilidade de
    // dependência não derruba a inicialização da aplicação.
    const client = createSqsClient(config({ endpoint: 'http://localhost:1' }));

    expect(client).toBeDefined();
    client.destroy();
  });

  it('limita as tentativas a um número pequeno', () => {
    // O backoff do SDK cobre oscilação curta. A retentativa de verdade é a
    // mensagem voltando pela fila, e multiplicar as duas faria o consumidor
    // segurar a mensagem além do visibility timeout.
    expect(SQS_MAX_ATTEMPTS).toBeGreaterThan(1);
    expect(SQS_MAX_ATTEMPTS).toBeLessThanOrEqual(5);
  });
});
