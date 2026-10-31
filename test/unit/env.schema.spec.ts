import { describe, expect, it } from 'bun:test';

import {
  MAX_LONG_POLL_SECONDS,
  envSchema,
  validateEnv,
} from '../../src/config/env.schema';

/*
  Teste de unidade puro: exercita o schema diretamente, sem processo, sem
  banco e sem fila. Nenhum mock envolvido.
*/

const validEnv: Record<string, string> = {
  NODE_ENV: 'test',
  APP_PORT: '3000',
  LOG_LEVEL: 'info',
  POSTGRES_HOST: 'localhost',
  POSTGRES_PORT: '5433',
  POSTGRES_USER: 'wagering',
  POSTGRES_PASSWORD: 'wagering',
  POSTGRES_DB: 'wagering',
  AWS_REGION: 'us-east-1',
  AWS_ACCESS_KEY_ID: 'test',
  AWS_SECRET_ACCESS_KEY: 'test',
  SQS_ENDPOINT: 'http://localhost:4566',
  SQS_QUEUE_NAME: 'wager-transactions.fifo',
  SQS_DLQ_NAME: 'wager-transactions-dlq.fifo',
  SQS_EVENTS_QUEUE_NAME: 'wagering-events.fifo',
  SQS_EVENTS_DLQ_NAME: 'wagering-events-dlq.fifo',
  SQS_CONSUMER_NAME: 'wager-transactions-consumer',
};

describe('contrato de variáveis de ambiente', () => {
  it('aceita o conjunto completo e converte números', () => {
    const parsed = validateEnv(validEnv);

    expect(parsed.APP_PORT).toBe(3000);
    expect(parsed.POSTGRES_PORT).toBe(5433);
    expect(parsed.NODE_ENV).toBe('test');
  });

  it('rejeita fila principal que não seja FIFO', () => {
    expect(() =>
      validateEnv({ ...validEnv, SQS_QUEUE_NAME: 'wager-transactions' }),
    ).toThrow(/\.fifo/);
  });

  it('rejeita DLQ que não seja FIFO', () => {
    expect(() =>
      validateEnv({ ...validEnv, SQS_DLQ_NAME: 'wager-transactions-dlq' }),
    ).toThrow(/\.fifo/);
  });

  it('rejeita fila de eventos que não seja FIFO', () => {
    expect(() =>
      validateEnv({ ...validEnv, SQS_EVENTS_QUEUE_NAME: 'wagering-events' }),
    ).toThrow(/\.fifo/);
  });

  it('rejeita DLQ de eventos que não seja FIFO', () => {
    expect(() =>
      validateEnv({ ...validEnv, SQS_EVENTS_DLQ_NAME: 'wagering-events-dlq' }),
    ).toThrow(/\.fifo/);
  });

  it('exige a fila de eventos — ela não tem default', () => {
    const withoutEvents = { ...validEnv };
    delete withoutEvents.SQS_EVENTS_QUEUE_NAME;

    // Sem default de propósito: um nome inventado aqui faria o publicador
    // criar eventos numa fila que ninguém consome, e o sintoma seria
    // "evento sumiu", não "configuração faltando".
    expect(() => validateEnv(withoutEvents)).toThrow(/SQS_EVENTS_QUEUE_NAME/);
  });

  it('tem defaults utilizáveis para consumidor e workers', () => {
    const parsed = validateEnv(validEnv);

    expect(parsed.CONSUMER_MAX_MESSAGES).toBe(10);
    expect(parsed.WORKER_SHUTDOWN_TIMEOUT_MS).toBe(8_000);
    expect(parsed.OUTBOX_POLL_INTERVAL_MS).toBe(1_000);
    expect(parsed.OUTBOX_BATCH_SIZE).toBe(20);
    expect(parsed.REFERENCE_POLL_INTERVAL_MS).toBe(5_000);
    expect(parsed.REFERENCE_BATCH_SIZE).toBe(20);
  });

  it('recusa lote acima do teto de dez mensagens da AWS', () => {
    expect(() =>
      validateEnv({ ...validEnv, CONSUMER_MAX_MESSAGES: '11' }),
    ).toThrow(/CONSUMER_MAX_MESSAGES/);
  });

  it('converte os prazos para número', () => {
    const parsed = validateEnv({
      ...validEnv,
      OUTBOX_POLL_INTERVAL_MS: '50',
      REFERENCE_BATCH_SIZE: '5',
    });

    expect(parsed.OUTBOX_POLL_INTERVAL_MS).toBe(50);
    expect(parsed.REFERENCE_BATCH_SIZE).toBe(5);
  });

  it('mantém o encerramento gracioso abaixo do SIGKILL do Compose', () => {
    // O Compose dá 10 s entre SIGTERM e SIGKILL. Um prazo de shutdown maior
    // que isso nunca termina: o processo morre antes de devolver a
    // visibilidade das mensagens em andamento.
    const parsed = validateEnv(validEnv);

    expect(parsed.WORKER_SHUTDOWN_TIMEOUT_MS).toBeLessThan(10_000);
  });

  it('relata todas as variáveis inválidas de uma vez, não só a primeira', () => {
    const broken = { ...validEnv };
    delete broken.POSTGRES_HOST;
    delete broken.AWS_REGION;

    let message = '';
    try {
      validateEnv(broken);
    } catch (error) {
      message = error instanceof Error ? error.message : '';
    }

    expect(message).toContain('POSTGRES_HOST');
    expect(message).toContain('AWS_REGION');
  });

  it('aceita endpoint vazio, que significa AWS real', () => {
    const parsed = validateEnv({ ...validEnv, SQS_ENDPOINT: '' });
    expect(parsed.SQS_ENDPOINT).toBe('');
  });

  it('rejeita endpoint que não seja URL', () => {
    expect(() =>
      validateEnv({ ...validEnv, SQS_ENDPOINT: 'nao-e-url' }),
    ).toThrow();
  });

  it('rejeita porta fora da faixa', () => {
    expect(() => validateEnv({ ...validEnv, APP_PORT: '70000' })).toThrow();
  });

  it('aplica defaults quando a variável é opcional', () => {
    const minimal = { ...validEnv };
    delete minimal.LOG_LEVEL;
    delete minimal.APP_PORT;

    const parsed = envSchema.parse(minimal);
    expect(parsed.LOG_LEVEL).toBe('info');
    expect(parsed.APP_PORT).toBe(3000);
  });
});

describe('prazos de indisponibilidade', () => {
  it('o default de requisição do SQS tolera um long poll inteiro', () => {
    // A relação que importa: timeout de transporte **abaixo** do long poll
    // abortaria todo `ReceiveMessage` normal, e o sintoma seria um consumidor
    // que nunca recebe nada sem acusar erro.
    const parsed = validateEnv(validEnv);

    expect(parsed.SQS_REQUEST_TIMEOUT_MS).toBeGreaterThan(
      MAX_LONG_POLL_SECONDS * 1_000,
    );
  });

  it('recusa timeout de requisição menor que o long poll', () => {
    expect(() =>
      validateEnv({
        ...validEnv,
        SQS_REQUEST_TIMEOUT_MS: String(MAX_LONG_POLL_SECONDS * 1_000 - 1),
      }),
    ).toThrow(/long poll/);
  });

  it('recusa timeout de requisição sem a margem acima do long poll', () => {
    expect(() =>
      validateEnv({ ...validEnv, SQS_REQUEST_TIMEOUT_MS: '21000' }),
    ).toThrow(/long poll/);
  });

  it('aceita timeout de requisição com a margem', () => {
    const parsed = validateEnv({
      ...validEnv,
      SQS_REQUEST_TIMEOUT_MS: '25000',
    });

    expect(parsed.SQS_REQUEST_TIMEOUT_MS).toBe(25_000);
  });

  it('o prazo de conexão é bem menor que o de requisição', () => {
    // Não conseguir abrir a conexão é indisponibilidade imediata: não há long
    // poll nenhum a tolerar.
    const parsed = validateEnv(validEnv);

    expect(parsed.SQS_CONNECTION_TIMEOUT_MS).toBeLessThan(
      parsed.SQS_REQUEST_TIMEOUT_MS,
    );
  });

  it('o prazo do health check é curto o bastante para uma sonda', () => {
    const parsed = validateEnv(validEnv);

    expect(parsed.HEALTH_CHECK_TIMEOUT_MS).toBeLessThanOrEqual(5_000);
  });

  it('recusa prazo de health check absurdo nas duas pontas', () => {
    expect(() =>
      validateEnv({ ...validEnv, HEALTH_CHECK_TIMEOUT_MS: '0' }),
    ).toThrow();

    expect(() =>
      validateEnv({ ...validEnv, HEALTH_CHECK_TIMEOUT_MS: '120000' }),
    ).toThrow();
  });
});
