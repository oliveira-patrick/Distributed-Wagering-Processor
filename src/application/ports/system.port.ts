/*
  Relógio e gerador de identificadores como portas.

  Não é cerimônia: os casos de uso gravam `createdAt`, `processedAt` e o
  instante da próxima tentativa de referência, e geram o id da transação, do
  lançamento e do evento. Com `new Date()` e `crypto.randomUUID()` chamados
  direto, nenhum desses valores é verificável num teste — e o que se precisa
  provar inclui ordem de eventos e agendamento de reprocessamento, que são
  afirmações **sobre** esses valores.

  A implementação de produção é a óbvia; a de teste é determinística.
*/
export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  next(): string;
}

export const CLOCK = 'CLOCK';
export const ID_GENERATOR = 'ID_GENERATOR';
