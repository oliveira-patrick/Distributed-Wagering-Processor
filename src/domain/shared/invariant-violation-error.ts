/*
  Erro de programação, não caminho de negócio.

  Separado de `DomainError` de propósito: um `DomainError` carrega
  `failureCode` porque o provedor precisa dele para decidir o que fazer, e é
  uma resposta legítima a um pedido bem formado. Já isto aqui significa que o
  código chamou uma operação impossível — transicionar uma transação
  terminal, pedir a direção de ledger de um `LOSS` — e nenhuma dessas
  situações tem resposta útil para o provedor. Transicionar a partir de um
  estado terminal é exatamente desse tipo.

  Na borda HTTP isso virará 500, e deve: não existe payload que o provedor
  possa corrigir para contornar um bug nosso.
*/
export class InvariantViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}
