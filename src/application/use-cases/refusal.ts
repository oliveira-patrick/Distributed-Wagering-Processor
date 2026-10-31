import type { FailureCode } from '../../domain/shared/failure-code';

/*
  Recusa decidida **antes** de haver transação para auditar.

  A distinção não é cosmética. Uma transação recusada por regra de negócio é
  persistida como `REJECTED`, fica auditável e gera evento — é resultado de uma
  avaliação. Já um payload que aponta para uma wallet inexistente não chega a
  ser uma operação: a linha nem é representável no schema, porque a foreign key
  composta exige uma wallet existente na mesma moeda.

  Então estas recusas respondem com código e sem `transactionId`, e isso está
  documentado como interpretação adicional. Não há
  perda de idempotência: nenhuma das duas tentativas produziu efeito, e é
  efeito duplicado que a idempotência existe para impedir.
*/
export interface Refusal {
  readonly outcome: 'refused';
  readonly failureCode: FailureCode;
  readonly detail: string;
}

export function refused(failureCode: FailureCode, detail: string): Refusal {
  return { outcome: 'refused', failureCode, detail };
}
