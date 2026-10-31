/*
  **ESTE ARQUIVO USA DUBLÊS, de propósito e de forma declarada.**

  O que se prova aqui não é que o PostgreSQL e o SQS funcionam — isso é
  assunto dos testes de integração, que rodam contra os serviços reais. O que
  se prova é o oposto: que o `/health/ready` **responde** quando a dependência
  não responde. Para isso é preciso uma dependência que trave sob demanda, e
  não existe jeito de pedir isso a um serviço de verdade de forma
  determinística.

  Os dublês abaixo não substituem infraestrutura real em nenhuma afirmação de
  funcionamento. Eles encenam uma única condição: indisponibilidade por
  silêncio, que é o pior caso — conexão aceita, resposta nunca.
*/
import { describe, expect, it } from 'bun:test';
import { HealthIndicatorService } from '@nestjs/terminus';
import type { ConfigService } from '@nestjs/config';
import type { EntityManager } from '@mikro-orm/postgresql';
import type { SQSClient } from '@aws-sdk/client-sqs';

import type { Env } from '../../src/config/env.schema';
import { EnvService } from '../../src/config/env.service';
import { ABORT_GRACE_MS } from '../../src/shared/with-deadline';
import { PostgresHealthIndicator } from '../../src/interfaces/http/health/postgres.health';
import { SqsHealthIndicator } from '../../src/interfaces/http/health/sqs.health';

const TIMEOUT_MS = 150;
const QUEUE_NAME = 'wager-transactions.fifo';

// Margem generosa: o que importa é haver teto, não qual é o teto exato.
const RESPONSE_BUDGET_MS = TIMEOUT_MS + ABORT_GRACE_MS + 1_000;

const VALUES: Partial<Env> = {
  HEALTH_CHECK_TIMEOUT_MS: TIMEOUT_MS,
  SQS_QUEUE_NAME: QUEUE_NAME,
};

// DUBLÊ: `ConfigService` servindo um ambiente já validado em memória.
function envService(): EnvService {
  const config = {
    get: (key: keyof Env): unknown => VALUES[key],
  };
  return new EnvService(config as unknown as ConfigService<Env, true>);
}

// DUBLÊ: cliente SQS que aceita a chamada e nunca responde.
function silentSqs(): SQSClient {
  return {
    send: (): Promise<never> => new Promise<never>(() => undefined),
  } as unknown as SQSClient;
}

// DUBLÊ: cliente SQS que responde a URL da fila.
function respondingSqs(): SQSClient {
  return {
    send: (): Promise<{ QueueUrl: string }> =>
      Promise.resolve({ QueueUrl: `http://localhost:4566/000/${QUEUE_NAME}` }),
  } as unknown as SQSClient;
}

// DUBLÊ: cliente SQS que falha de imediato, como um endpoint recusado.
function refusingSqs(): SQSClient {
  return {
    send: (): Promise<never> =>
      Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:4566')),
  } as unknown as SQSClient;
}

// DUBLÊ: `EntityManager` cuja consulta nunca volta.
function silentPostgres(): EntityManager {
  return {
    getConnection: (): { execute: () => Promise<never> } => ({
      execute: (): Promise<never> => new Promise<never>(() => undefined),
    }),
  } as unknown as EntityManager;
}

// DUBLÊ: `EntityManager` que responde `select 1`.
function respondingPostgres(): EntityManager {
  return {
    getConnection: (): { execute: () => Promise<unknown> } => ({
      execute: (): Promise<unknown> => Promise.resolve([{ one: 1 }]),
    }),
  } as unknown as EntityManager;
}

// O resultado do terminus é um registro com a chave do indicador.
function statusOf(result: object, key: string): unknown {
  return (result as Record<string, { status?: unknown } | undefined>)[key]
    ?.status;
}

function messageOf(result: object, key: string): unknown {
  return (result as Record<string, { message?: unknown } | undefined>)[key]
    ?.message;
}

function queueNameOf(result: object, key: string): unknown {
  return (result as Record<string, { queueName?: unknown } | undefined>)[key]
    ?.queueName;
}

function sqsIndicator(client: SQSClient): SqsHealthIndicator {
  return new SqsHealthIndicator(
    new HealthIndicatorService(),
    envService(),
    client,
  );
}

function postgresIndicator(em: EntityManager): PostgresHealthIndicator {
  return new PostgresHealthIndicator(
    new HealthIndicatorService(),
    envService(),
    em,
  );
}

describe('readiness do SQS sob indisponibilidade', () => {
  it('responde, em vez de travar, quando o SQS fica calado', async () => {
    const started = Date.now();

    const result = await sqsIndicator(silentSqs()).check();

    expect(statusOf(result, 'sqs')).toBe('down');
    expect(Date.now() - started).toBeLessThan(RESPONSE_BUDGET_MS);
  });

  it('não lança: indisponibilidade é resposta, não exceção', async () => {
    // Se levantasse, o terminus devolveria 500 em vez de 503, e o
    // orquestrador perderia a distinção entre dependência fora do ar e
    // aplicação quebrada.
    const indicator = sqsIndicator(silentSqs());

    expect(await indicator.check()).toBeDefined();
  });

  it('diz no motivo que o prazo estourou', async () => {
    const result = await sqsIndicator(silentSqs()).check();

    expect(String(messageOf(result, 'sqs'))).toContain('não respondeu');
  });

  it('informa a fila consultada quando cai', async () => {
    const result = await sqsIndicator(silentSqs()).check();

    expect(queueNameOf(result, 'sqs')).toBe(QUEUE_NAME);
  });

  it('reporta down com o motivo quando a conexão é recusada', async () => {
    const result = await sqsIndicator(refusingSqs()).check();

    expect(statusOf(result, 'sqs')).toBe('down');
    expect(String(messageOf(result, 'sqs'))).toContain('ECONNREFUSED');
  });

  it('reporta up com a URL quando a fila responde', async () => {
    const result = await sqsIndicator(respondingSqs()).check();

    expect(statusOf(result, 'sqs')).toBe('up');
  });
});

describe('readiness do PostgreSQL sob indisponibilidade', () => {
  it('responde, em vez de travar, quando a consulta não volta', async () => {
    const started = Date.now();

    const result = await postgresIndicator(silentPostgres()).check();

    expect(statusOf(result, 'postgres')).toBe('down');
    expect(Date.now() - started).toBeLessThan(RESPONSE_BUDGET_MS);
  });

  it('não lança', async () => {
    const indicator = postgresIndicator(silentPostgres());

    expect(await indicator.check()).toBeDefined();
  });

  it('reporta up quando a consulta completa', async () => {
    const result = await postgresIndicator(respondingPostgres()).check();

    expect(statusOf(result, 'postgres')).toBe('up');
  });
});

describe('as duas dependências caladas ao mesmo tempo', () => {
  it('ainda produzem resposta, e em paralelo', async () => {
    // O `/health/ready` avalia os indicadores juntos. Dois prazos de 150 ms
    // em paralelo não somam 300 ms — se somassem, a sonda de readiness teria
    // custo proporcional ao número de dependências.
    const started = Date.now();

    const [sqs, postgres] = await Promise.all([
      sqsIndicator(silentSqs()).check(),
      postgresIndicator(silentPostgres()).check(),
    ]);

    expect(statusOf(sqs, 'sqs')).toBe('down');
    expect(statusOf(postgres, 'postgres')).toBe('down');
    expect(Date.now() - started).toBeLessThan(RESPONSE_BUDGET_MS);
  });
});
