import { randomUUID } from 'node:crypto';

import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Headers,
  Inject,
  Param,
  Post,
  Res,
} from '@nestjs/common';

import { METRICS, MetricSource } from '../../application/ports/metrics.port';
import type { MetricsPort } from '../../application/ports/metrics.port';
import {
  SubmissionOperation,
  recordSubmission,
} from '../../application/use-cases/submission-telemetry';

import { submitWagerTransactionSchema } from '../../application/contracts/submit-wager-transaction.command';
import type { SubmitWagerTransactionPayload } from '../../application/contracts/submit-wager-transaction.command';
import { SubmitWagerTransactionUseCase } from '../../application/use-cases/submit-wager-transaction.use-case';
import { GetWagerTransactionUseCase } from '../../application/use-cases/wager-transaction-queries.use-case';
import { FailureCode } from '../../domain/shared/failure-code';
import { FailureException } from './failure.exception';
import { httpStatusForTransaction } from './failure-http';
import {
  presentSubmitResult,
  presentTransaction,
} from './presenters/wagering.presenter';
import type {
  SubmitTransactionResponse,
  WagerTransactionResponse,
} from './presenters/wagering.presenter';
import { ZodPipe } from './zod.pipe';

/*
  O mínimo que se usa do objeto de resposta.

  Tipado assim em vez de importar `Response` do Express para que o controller
  não passe a depender do tipo do adaptador HTTP por causa de uma chamada. O
  que se precisa é definir o status, e é só isso que o tipo promete.
*/
interface StatusSettable {
  status(code: number): unknown;
}

// `POST /wagering/transactions` e `GET /wagering/transactions/:id`.
@Controller('wagering')
export class WageringController {
  constructor(
    private readonly submitTransaction: SubmitWagerTransactionUseCase,
    private readonly getTransaction: GetWagerTransactionUseCase,
    @Inject(METRICS) private readonly metrics: MetricsPort,
  ) {}

  /*
    O status sai do desfecho, não de um `@HttpCode` fixo.

    São cinco situações a distinguir, e três delas convivem
    no mesmo endpoint com corpo de sucesso: aplicada (200), aceita e pendente
    (202) e recusada pelo negócio (422, com o `failureCode`). Daí o status ser
    calculado — `@HttpCode` serve para um valor constante, e aqui não há um.

    `200` para aplicada, e não `201`, porque o contrato promete que requisição
    idêntica devolve **a mesma resposta**: se o original fosse 201 e o replay
    200, a promessa não valeria.
  */
  @Post('transactions')
  @HttpCode(HttpStatus.OK)
  async submit(
    @Body(new ZodPipe(submitWagerTransactionSchema))
    payload: SubmitWagerTransactionPayload,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Headers('x-correlation-id') correlationId: string | undefined,
    @Headers('authorization') authorization: string | undefined,
    @Res({ passthrough: true }) response: StatusSettable,
  ): Promise<SubmitTransactionResponse> {
    /*
      O header é obrigatório e é a fonte da verdade da idempotência. Aceitar
      a ausência e derivar a chave do payload pareceria conveniente e tiraria
      do provedor a decisão de qual operação é repetição de qual.
    */
    if (idempotencyKey === undefined || idempotencyKey.trim() === '') {
      throw new FailureException(
        FailureCode.VALIDATION_FAILED,
        'o header Idempotency-Key é obrigatório',
      );
    }

    const startedAt = Date.now();
    const result = await this.submitTransaction.execute({
      idempotencyKey,
      correlationId: correlationId ?? randomUUID(),
      payload,
      credential: authorization,
    });

    /*
      Registrado aqui, e não dentro do caso de uso, porque é o ponto de
      entrada que sabe a sua origem: o consumidor da fila reusa o mesmo caso
      de uso e registra `sqs`. Com o registro lá dentro, as duas entradas
      viriam com o mesmo rótulo e a métrica deixaria de distinguir uma fila
      parada de um provedor calado.
    */
    recordSubmission(
      this.metrics,
      MetricSource.Http,
      SubmissionOperation.Submit,
      result,
      (Date.now() - startedAt) / 1_000,
    );

    if (result.outcome === 'refused') {
      throw new FailureException(result.failureCode, result.detail);
    }

    response.status(
      httpStatusForTransaction(
        result.transaction.status,
        result.transaction.failureCode,
      ),
    );

    return presentSubmitResult(
      result.transaction,
      result.balance,
      result.idempotentReplay,
    );
  }

  @Get('transactions/:transactionId')
  async byId(
    @Param('transactionId') transactionId: string,
  ): Promise<WagerTransactionResponse> {
    const result = await this.getTransaction.byId(transactionId);

    if (result.outcome === 'refused') {
      throw new FailureException(result.failureCode, result.detail);
    }

    return presentTransaction(result.transaction);
  }
}

/*
  `GET /providers/:providerId/wagering/transactions/:externalTransactionId`.

  Controller próprio porque o prefixo é outro. É a consulta pela chave que o
  provedor conhece, e o que torna a API recuperável: quem perdeu a resposta de
  um `POST` descobre o que aconteceu sem ter guardado o id interno.
*/
@Controller('providers')
export class ProviderTransactionsController {
  constructor(private readonly getTransaction: GetWagerTransactionUseCase) {}

  @Get(':providerId/wagering/transactions/:externalTransactionId')
  async byExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ): Promise<WagerTransactionResponse> {
    const result = await this.getTransaction.byProviderAndExternalId(
      providerId,
      externalTransactionId,
    );

    if (result.outcome === 'refused') {
      throw new FailureException(result.failureCode, result.detail);
    }

    return presentTransaction(result.transaction);
  }
}
