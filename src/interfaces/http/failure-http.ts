import { HttpStatus } from '@nestjs/common';

import { FailureCode } from '../../domain/shared/failure-code';
import { WagerTransactionStatus } from '../../domain/wagering/wager-transaction-status';

/*
  Código de falha para status HTTP.

  A exigência é uma só: que a API distinga com clareza, e de forma
  **consistente entre todos os endpoints**, payload inválido, conflito de
  idempotência, rejeição por regra de negócio, aceite com processamento
  pendente e falha transitória de infraestrutura. Colapsar essas situações
  obriga o provedor a interpretar mensagem de erro para decidir se pode
  reenviar.

  A linha entre 400 e 422 é a que organiza o resto: **400 diz que a
  requisição está errada; 422, que ela está correta e o negócio a recusou.**
  Reenviar um 400 sem mexer no payload não leva a lugar nenhum; um 422 é
  resposta final sobre um pedido bem formado.

  O mapa é total sobre `FailureCode` — `Record` sem opcional —, então um código
  novo sem status definido não compila. É deliberado: a alternativa seria um
  default silencioso que mandaria 500 para uma recusa de negócio.
*/
const STATUS_BY_FAILURE: Readonly<Record<FailureCode, HttpStatus>> = {
  // A requisição está errada.
  [FailureCode.VALIDATION_FAILED]: HttpStatus.BAD_REQUEST,

  // Conflito: o recurso ou a chave já existe com outro significado.
  [FailureCode.IDEMPOTENCY_CONFLICT]: HttpStatus.CONFLICT,
  [FailureCode.WALLET_ALREADY_EXISTS]: HttpStatus.CONFLICT,

  // Não existe.
  [FailureCode.WALLET_NOT_FOUND]: HttpStatus.NOT_FOUND,
  [FailureCode.TRANSACTION_NOT_FOUND]: HttpStatus.NOT_FOUND,

  // Pedido bem formado, recusado pelo negócio.
  [FailureCode.CURRENCY_MISMATCH]: HttpStatus.UNPROCESSABLE_ENTITY,
  [FailureCode.INSUFFICIENT_FUNDS]: HttpStatus.UNPROCESSABLE_ENTITY,
  [FailureCode.REVERSAL_WOULD_OVERDRAW]: HttpStatus.UNPROCESSABLE_ENTITY,
  [FailureCode.REFERENCE_NOT_FOUND]: HttpStatus.UNPROCESSABLE_ENTITY,
  [FailureCode.REFERENCE_MISMATCH]: HttpStatus.UNPROCESSABLE_ENTITY,
  [FailureCode.REFERENCE_KIND_INVALID]: HttpStatus.UNPROCESSABLE_ENTITY,
  [FailureCode.ALREADY_REVERSED]: HttpStatus.UNPROCESSABLE_ENTITY,
  [FailureCode.AMOUNT_MISMATCH]: HttpStatus.UNPROCESSABLE_ENTITY,

  // Transitório: reenviar faz sentido.
  [FailureCode.TRANSPORT_UNAVAILABLE]: HttpStatus.SERVICE_UNAVAILABLE,
};

export function httpStatusFor(failureCode: FailureCode): HttpStatus {
  return STATUS_BY_FAILURE[failureCode];
}

/*
  Status de transação persistida para status HTTP.

  `PROCESSED` responde **200, não 201**, e a razão é a promessa de que
  requisição idêntica devolve a mesma resposta. Se o original fosse 201 e o
  replay 200, a
  resposta não seria a mesma. Com 200 nos dois, a promessa vale literalmente, e
  quem informa que houve replay é o campo `idempotentReplay` no corpo.

  `PENDING_REFERENCE` é 202: aceita, ainda não aplicada — é exatamente o
  "aceite com processamento pendente", distinto de tudo o mais.

  `REJECTED` e `FAILED` saem pelo código de falha, porque é ele que diz ao
  provedor o que fazer.
*/
export function httpStatusForTransaction(
  status: WagerTransactionStatus,
  failureCode: FailureCode | undefined,
): HttpStatus {
  switch (status) {
    case WagerTransactionStatus.Processed:
      return HttpStatus.OK;

    case WagerTransactionStatus.PendingReference:
      return HttpStatus.ACCEPTED;

    case WagerTransactionStatus.Rejected:
    case WagerTransactionStatus.Failed:
      return failureCode === undefined
        ? HttpStatus.UNPROCESSABLE_ENTITY
        : httpStatusFor(failureCode);

    case WagerTransactionStatus.Pending:
      // Não deveria sair do caso de uso: ele só devolve estado decidido.
      return HttpStatus.ACCEPTED;
  }
}
