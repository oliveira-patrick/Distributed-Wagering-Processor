import { EntitySchema } from '@mikro-orm/core';

/*
  Linha de `outbox_messages`.

  `payload` é `jsonb` e guarda o envelope do evento já serializado — o mesmo
  corpo que será publicado. Gravar o envelope pronto, e não os campos soltos
  para montar depois, é o que garante que o evento publicado é exatamente o
  que foi decidido dentro da transação.
*/
export class OutboxMessageRow {
  id!: string;
  aggregateId!: string;
  eventType!: string;
  payload!: Record<string, unknown>;
  occurredAt!: Date;
  attempts!: number;
  nextAttemptAt!: Date | null;
  publishedAt!: Date | null;
}

export const outboxMessageSchema = new EntitySchema<OutboxMessageRow>({
  class: OutboxMessageRow,
  tableName: 'outbox_messages',
  properties: {
    id: { type: 'uuid', primary: true },
    aggregateId: { type: 'string' },
    eventType: { type: 'string' },
    payload: { type: 'json', columnType: 'jsonb' },
    occurredAt: { type: 'datetime', columnType: 'timestamptz' },
    attempts: { type: 'number' },
    nextAttemptAt: {
      type: 'datetime',
      columnType: 'timestamptz',
      nullable: true,
    },
    publishedAt: {
      type: 'datetime',
      columnType: 'timestamptz',
      nullable: true,
    },
  },
});
