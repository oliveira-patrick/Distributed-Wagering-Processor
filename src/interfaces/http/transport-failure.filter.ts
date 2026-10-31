import { Catch, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';

import { FailureCode } from '../../domain/shared/failure-code';
import { describeError } from '../../shared/describe-error';
import { isTransportFailure } from '../../shared/transport-failure';
import type { FailureBody } from './failure.exception';

interface ResponseLike {
  status(code: number): ResponseLike;
  json(body: unknown): unknown;
}

/*
  Traduz falha de infraestrutura em `503`, e deixa o resto como está.

  É a quinta das situações que a API distingue, e a única que não nasce
  de uma decisão do caso de uso: ela vem de baixo, como exceção do driver, e
  sem este filtro cairia no 500 genérico do Nest. Para o provedor isso é a
  diferença entre reenviar e desistir.

  `HttpException` passa intacta de propósito: as recusas já decidiram o status
  e o corpo, e reinterpretá-las aqui criaria duas fontes da verdade para o
  mesmo contrato.

  O que não for transporte nem `HttpException` continua `500`. É o certo: erro
  desconhecido em sistema financeiro não deve ser anunciado como transitório,
  porque isso convida o provedor a reenviar uma operação que talvez tenha sido
  aplicada.
*/
@Catch()
export class TransportFailureFilter implements ExceptionFilter {
  private readonly logger = new Logger(TransportFailureFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<ResponseLike>();

    if (exception instanceof HttpException) {
      response.status(exception.getStatus()).json(exception.getResponse());
      return;
    }

    if (isTransportFailure(exception)) {
      const body: FailureBody = {
        failureCode: FailureCode.TRANSPORT_UNAVAILABLE,
        message: 'dependência temporariamente indisponível',
      };

      this.logger.warn(`transporte indisponível: ${describeError(exception)}`);
      response.status(HttpStatus.SERVICE_UNAVAILABLE).json(body);
      return;
    }

    this.logger.error(`falha não tratada: ${describeError(exception)}`);
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      message: 'erro interno',
    });
  }
}
