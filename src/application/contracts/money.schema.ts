import { z } from 'zod';

import { MAX_OPERATION_AMOUNT, Money } from '../../domain/money/money';

/*
  Contrato de representação monetária na **entrada**.

  Uma função central de normalização, e não uma regra por endpoint. É o que
  garante que `"25"`, `"25.0"` e `"0025.00"` cheguem como o mesmo valor em
  qualquer porta de entrada — HTTP hoje, fila amanhã —, e que a recusa de
  `"25.001"` seja idêntica nas duas.

  Quem valida formato e converte é `Money.from`, um parser só. O zod entra por
  cima dele por um motivo específico: ele sabe o **caminho do campo**, então o
  provedor recebe `money.amount` em vez de uma mensagem solta sobre um valor
  que ele não consegue localizar no payload.

  As restrições de **sinal e de limite de operação** não ficam aqui — ficam
  nos schemas derivados, porque pertencem ao contrato de cada operação. `Money`
  representa negativos de propósito: `negate()` e a diferença da reconciliação
  precisam deles.
*/
export const moneySchema = z
  .object({
    /*
      `z.string()` antes de qualquer coisa: número JSON é recusado aqui, e não
      convertido em string por acidente.
    */
    amount: z.string(),
    currency: z.string(),
  })
  .transform((value, ctx): Money => {
    try {
      return Money.from(value);
    } catch (error) {
      ctx.addIssue({
        code: 'custom',
        message: error instanceof Error ? error.message : 'valor inválido',
      });
      return z.NEVER;
    }
  });

// Saldo inicial de wallet: zero é permitido, negativo não.
export const openingMoneySchema = moneySchema.refine(
  (money) => !money.isNegative(),
  { message: 'o saldo inicial não pode ser negativo' },
);

/*
  Valor de uma operação de aposta: estritamente positivo e abaixo do teto.

  O teto é `MAX_OPERATION_AMOUNT`, separado do limite do tipo: uma aposta de um
  bilhão já é absurda, e o tipo precisa representar saldos maiores que qualquer
  operação individual. O teto é decisão nossa, declarada no ADR-005.
*/
export const operationMoneySchema = moneySchema
  .refine((money) => money.isPositive(), {
    message: 'o valor da operação precisa ser positivo',
  })
  .refine((money) => withinOperationLimit(money), {
    message: `o valor da operação não pode exceder ${MAX_OPERATION_AMOUNT}`,
  });

function withinOperationLimit(money: Money): boolean {
  const cap = Money.from({
    amount: MAX_OPERATION_AMOUNT,
    currency: money.currency,
  });
  return !cap.isLessThan(money);
}
