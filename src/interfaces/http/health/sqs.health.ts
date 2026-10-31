import { GetQueueUrlCommand, SQSClient } from '@aws-sdk/client-sqs';
import { Inject, Injectable } from '@nestjs/common';
import { HealthIndicatorService } from '@nestjs/terminus';
import type { HealthIndicatorResult } from '@nestjs/terminus';

import { EnvService } from '../../../config/env.service';
import { describeError } from '../../../shared/describe-error';
import { ABORT_GRACE_MS, withDeadline } from '../../../shared/with-deadline';
import { SQS_CLIENT } from '../../../infrastructure/messaging/sqs.client';

/*
  Readiness do SQS.

  Resolve a URL da fila principal em vez de apenas abrir uma conexão: prova
  que o endpoint responde, que as credenciais são aceitas e que a fila que a
  aplicação vai consumir realmente existe. Um emulador no ar sem as filas
  criadas não é um sistema pronto.

  **O prazo é curto e é dele que depende a utilidade do endpoint.** O cliente
  tolera um long poll de 20 segundos, e esperar isso numa sonda de readiness
  deixaria o orquestrador sem resposta justamente quando ele precisa decidir
  se tira a instância do balanceador. Então a verificação impõe o prazo dela:
  demorar é estar indisponível.
*/
@Injectable()
export class SqsHealthIndicator {
  constructor(
    private readonly health: HealthIndicatorService,
    private readonly env: EnvService,
    @Inject(SQS_CLIENT) private readonly client: SQSClient,
  ) {}

  async check(key = 'sqs'): Promise<HealthIndicatorResult> {
    const session = this.health.check(key);
    const timeoutMs = this.env.health.timeoutMs;

    try {
      /*
        Duas barreiras, com papéis diferentes: o `AbortSignal` cancela a
        requisição HTTP de verdade, liberando o socket; `withDeadline`
        garante que esta função responda mesmo que o sinal seja ignorado.
        A segunda existe porque a promessa feita aqui — readiness sempre
        responde — não deve depender do SDK honrar um cancelamento.
      */
      const result = await withDeadline(
        this.client.send(
          new GetQueueUrlCommand({ QueueName: this.env.sqs.queueName }),
          { abortSignal: AbortSignal.timeout(timeoutMs) },
        ),
        timeoutMs + ABORT_GRACE_MS,
        `SQS GetQueueUrl ${this.env.sqs.queueName}`,
      );
      return session.up({ queueUrl: result.QueueUrl ?? null });
    } catch (error) {
      return session.down({
        message: describeError(error),
        queueName: this.env.sqs.queueName,
      });
    }
  }
}
