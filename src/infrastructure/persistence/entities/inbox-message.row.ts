import { EntitySchema } from '@mikro-orm/core';

/*
  Linha de `inbox_messages` — chave primária composta
  `(consumer_name, message_id)`.
*/
export class InboxMessageRow {
  consumerName!: string;
  messageId!: string;
  payloadHash!: string;
  receivedAt!: Date;
  processedAt!: Date | null;
}

export const inboxMessageSchema = new EntitySchema<InboxMessageRow>({
  class: InboxMessageRow,
  tableName: 'inbox_messages',
  properties: {
    consumerName: { type: 'string', primary: true },
    messageId: { type: 'string', primary: true },
    payloadHash: { type: 'string', columnType: 'char(64)' },
    receivedAt: { type: 'datetime', columnType: 'timestamptz' },
    processedAt: {
      type: 'datetime',
      columnType: 'timestamptz',
      nullable: true,
    },
  },
});
