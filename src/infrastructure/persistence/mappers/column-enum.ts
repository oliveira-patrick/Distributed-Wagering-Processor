import { InvariantViolationError } from '../../../domain/shared/invariant-violation-error';

/*
  Estreita uma string vinda de coluna para a union de literais do domínio.

  Os enums do domínio são union de literais de string, então `"DEBIT"` **é**
  o tipo — mas o que o driver entrega é `string`, e `string` não é
  atribuível à union. O caminho honesto é verificar a pertinência em tempo de
  execução e devolver o literal que casou: nenhum cast, e valor inesperado
  para de viajar aqui em vez de virar um estado impossível três camadas
  acima.

  O schema já tem `check` para `kind`, `status` e `direction`, de modo que
  chegar aqui com valor fora da lista significa que alguém escreveu na tabela
  por fora — daí `InvariantViolationError`, que é erro de programação, e não
  `DomainError`, que é caminho de negócio.
*/
export function parseColumnEnum<T extends string>(
  allowed: readonly T[],
  value: string,
  column: string,
): T {
  for (const candidate of allowed) {
    if (candidate === value) {
      return candidate;
    }
  }

  throw new InvariantViolationError(
    `Coluna ${column} com valor fora do domínio: ${JSON.stringify(value)}`,
  );
}

// `null` da coluna vira `undefined` do domínio.
export function orUndefined<T>(value: T | null): T | undefined {
  return value ?? undefined;
}
