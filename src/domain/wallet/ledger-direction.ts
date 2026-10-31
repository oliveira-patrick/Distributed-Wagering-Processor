/*
  Sentido de um lançamento no ledger.

  Const object em vez de `enum` do TypeScript, aqui e nos outros dois enums
  do domínio. Nomes e assinaturas podem ser adaptados desde que as garantias
  se mantenham, e a troca tem uma razão concreta: `enum` do TypeScript é
  nominal, então `"DEBIT"` lido de uma coluna ou de um JSON da fila não é
  atribuível a `LedgerDirection` sem cast.
  Num sistema que desserializa `kind`, `status` e `direction` em todo
  caminho de entrada, isso significa um cast por caminho, e cada cast é um
  lugar onde um valor inválido passa sem ninguém notar. Com union de literais
  de string, `"DEBIT"` **é** o tipo, e o zod valida a borda sem conversão.
*/
export const LedgerDirection = {
  Debit: 'DEBIT',
  Credit: 'CREDIT',
} as const;

export type LedgerDirection =
  (typeof LedgerDirection)[keyof typeof LedgerDirection];

// Inverte o sentido. É o que uma reversão faz com o lançamento original.
export function invertDirection(direction: LedgerDirection): LedgerDirection {
  return direction === LedgerDirection.Debit
    ? LedgerDirection.Credit
    : LedgerDirection.Debit;
}
