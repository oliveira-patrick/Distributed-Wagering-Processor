import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Env } from './env.schema';

export interface PostgresConfig {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly database: string;
}

export interface SqsConfig {
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  // Vazio quando o destino é a AWS real.
  readonly endpoint: string;
  readonly queueName: string;
  readonly deadLetterQueueName: string;
  // Fila de saída dos eventos de integração — ver ADR-012.
  readonly eventsQueueName: string;
  readonly eventsDeadLetterQueueName: string;
  readonly consumerName: string;
  readonly requestTimeoutMs: number;
  readonly connectionTimeoutMs: number;
}

/*
  O que o cliente do SDK precisa saber: credenciais, endereço e prazos.

  Separado de `SqsConfig` porque o cliente não tem nada a ver com **quais**
  filas existem — ele abre conexão, e o nome da fila viaja em cada comando.
  Com o tipo largo, todo chamador que só quer um cliente era obrigado a
  inventar nomes de fila para preencher campos que ninguém lia.
*/
export type SqsTransportConfig = Pick<
  SqsConfig,
  | 'region'
  | 'accessKeyId'
  | 'secretAccessKey'
  | 'endpoint'
  | 'requestTimeoutMs'
  | 'connectionTimeoutMs'
>;

// Prazos e lotes do consumidor e dos workers.
export interface WorkersConfig {
  readonly consumerMaxMessages: number;
  readonly shutdownTimeoutMs: number;
  readonly outboxPollIntervalMs: number;
  readonly outboxBatchSize: number;
  readonly referencePollIntervalMs: number;
  readonly referenceBatchSize: number;
}

export interface HealthConfig {
  readonly timeoutMs: number;
}

/*
  Acesso tipado ao ambiente já validado.

  É o único ponto do sistema que lê `process.env`. As camadas abaixo recebem
  configuração pronta, nunca a consultam — a raiz de composição é quem sabe
  de onde vêm os valores.
*/
@Injectable()
export class EnvService {
  constructor(private readonly config: ConfigService<Env, true>) {}

  get nodeEnv(): Env['NODE_ENV'] {
    return this.config.get('NODE_ENV', { infer: true });
  }

  get isProduction(): boolean {
    return this.nodeEnv === 'production';
  }

  get appPort(): number {
    return this.config.get('APP_PORT', { infer: true });
  }

  get workerPort(): number {
    return this.config.get('WORKER_PORT', { infer: true });
  }

  get logLevel(): Env['LOG_LEVEL'] {
    return this.config.get('LOG_LEVEL', { infer: true });
  }

  get postgres(): PostgresConfig {
    return {
      host: this.config.get('POSTGRES_HOST', { infer: true }),
      port: this.config.get('POSTGRES_PORT', { infer: true }),
      user: this.config.get('POSTGRES_USER', { infer: true }),
      password: this.config.get('POSTGRES_PASSWORD', { infer: true }),
      database: this.config.get('POSTGRES_DB', { infer: true }),
    };
  }

  get sqs(): SqsConfig {
    return {
      region: this.config.get('AWS_REGION', { infer: true }),
      accessKeyId: this.config.get('AWS_ACCESS_KEY_ID', { infer: true }),
      secretAccessKey: this.config.get('AWS_SECRET_ACCESS_KEY', {
        infer: true,
      }),
      endpoint: this.config.get('SQS_ENDPOINT', { infer: true }),
      queueName: this.config.get('SQS_QUEUE_NAME', { infer: true }),
      deadLetterQueueName: this.config.get('SQS_DLQ_NAME', { infer: true }),
      eventsQueueName: this.config.get('SQS_EVENTS_QUEUE_NAME', {
        infer: true,
      }),
      eventsDeadLetterQueueName: this.config.get('SQS_EVENTS_DLQ_NAME', {
        infer: true,
      }),
      consumerName: this.config.get('SQS_CONSUMER_NAME', { infer: true }),
      requestTimeoutMs: this.config.get('SQS_REQUEST_TIMEOUT_MS', {
        infer: true,
      }),
      connectionTimeoutMs: this.config.get('SQS_CONNECTION_TIMEOUT_MS', {
        infer: true,
      }),
    };
  }

  get workers(): WorkersConfig {
    return {
      consumerMaxMessages: this.config.get('CONSUMER_MAX_MESSAGES', {
        infer: true,
      }),
      shutdownTimeoutMs: this.config.get('WORKER_SHUTDOWN_TIMEOUT_MS', {
        infer: true,
      }),
      outboxPollIntervalMs: this.config.get('OUTBOX_POLL_INTERVAL_MS', {
        infer: true,
      }),
      outboxBatchSize: this.config.get('OUTBOX_BATCH_SIZE', { infer: true }),
      referencePollIntervalMs: this.config.get('REFERENCE_POLL_INTERVAL_MS', {
        infer: true,
      }),
      referenceBatchSize: this.config.get('REFERENCE_BATCH_SIZE', {
        infer: true,
      }),
    };
  }

  get health(): HealthConfig {
    return {
      timeoutMs: this.config.get('HEALTH_CHECK_TIMEOUT_MS', { infer: true }),
    };
  }
}
