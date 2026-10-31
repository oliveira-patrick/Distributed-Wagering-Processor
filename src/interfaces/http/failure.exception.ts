import { HttpException, HttpStatus } from '@nestjs/common';
import type { ZodError } from 'zod';

import { FailureCode } from '../../domain/shared/failure-code';
import { httpStatusFor } from './failure-http';

export interface FailureBody {
  readonly failureCode: FailureCode;
  readonly message: string;
}

export interface ValidationIssue {
  readonly path: string;
  readonly message: string;
}

export interface ValidationBody extends FailureBody {
  readonly issues: readonly ValidationIssue[];
}

/*
  Recusa sem transação persistida.

  O corpo carrega o `failureCode` em vez de só a mensagem, porque é dele que
  um código estável e legível por máquina, e quem integra precisa decidir
  entre reenviar, corrigir o payload ou desistir **sem** fazer parsing de
  texto em português.
*/
export class FailureException extends HttpException {
  constructor(failureCode: FailureCode, message: string) {
    const body: FailureBody = { failureCode, message };
    super(body, httpStatusFor(failureCode));
  }
}

/*
  Payload fora do contrato de entrada.

  Lista todas as questões de uma vez, não só a primeira — mesma decisão do
  contrato de ambiente, e pelo mesmo motivo: devolver uma por requisição
  transforma a integração numa sequência de tentativas.
*/
export class ValidationException extends HttpException {
  constructor(error: ZodError) {
    const issues: ValidationIssue[] = error.issues.map((issue) => ({
      path: issue.path.map(String).join('.') || '(raiz)',
      message: issue.message,
    }));

    const body: ValidationBody = {
      failureCode: FailureCode.VALIDATION_FAILED,
      message: 'payload fora do contrato de entrada',
      issues,
    };

    super(body, HttpStatus.BAD_REQUEST);
  }
}
