import { InboxMessage } from '../../../domain/messaging/inbox-message';
import { OutboxMessage } from '../../../domain/messaging/outbox-message';
import type { InboxMessageRow } from '../entities/inbox-message.row';
import type { OutboxMessageRow } from '../entities/outbox-message.row';
import { orUndefined } from './column-enum';

export interface InboxUpdate {
  readonly processedAt: Date | null;
}

export interface OutboxUpdate {
  readonly attempts: number;
  readonly nextAttemptAt: Date | null;
  readonly publishedAt: Date | null;
}

export function toInboxDomain(row: InboxMessageRow): InboxMessage {
  return InboxMessage.rehydrate({
    consumerName: row.consumerName,
    messageId: row.messageId,
    payloadHash: row.payloadHash,
    receivedAt: row.receivedAt,
    processedAt: orUndefined(row.processedAt),
  });
}

export function toInboxUpdate(message: InboxMessage): InboxUpdate {
  return { processedAt: message.processedAt ?? null };
}

export function toInboxRow(message: InboxMessage): InboxMessageRow {
  return {
    consumerName: message.consumerName,
    messageId: message.messageId,
    payloadHash: message.payloadHash,
    receivedAt: message.receivedAt,
    ...toInboxUpdate(message),
  };
}

export function toOutboxDomain(row: OutboxMessageRow): OutboxMessage {
  return OutboxMessage.rehydrate({
    id: row.id,
    aggregateId: row.aggregateId,
    eventType: row.eventType,
    payload: row.payload,
    occurredAt: row.occurredAt,
    attempts: row.attempts,
    nextAttemptAt: orUndefined(row.nextAttemptAt),
    publishedAt: orUndefined(row.publishedAt),
  });
}

export function toOutboxUpdate(message: OutboxMessage): OutboxUpdate {
  return {
    attempts: message.attempts,
    nextAttemptAt: message.nextAttemptAt ?? null,
    publishedAt: message.publishedAt ?? null,
  };
}

/*
  Contrato de representação da outbox.

  Passa o envelope pela **mesma** serialização que o publicador usará, de
  modo que o que está na coluna seja o que vai para a fila. O detalhe que
  obriga a isso: `causationId` ausente é `undefined` em memória, e
  `JSON.stringify` descarta a chave — mas entregue direto ao driver o campo
  virava `"causationId": null` no `jsonb`, e o consumidor passaria a receber
  uma chave vazia que o contrato promete não existir. Normalizar aqui faz o
  envelope gravado e o publicado coincidirem por construção, em vez de por
  coincidência.
*/
function toPublishedJson(
  payload: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
}

export function toOutboxRow(message: OutboxMessage): OutboxMessageRow {
  return {
    id: message.id,
    aggregateId: message.aggregateId,
    eventType: message.eventType,
    /*
      O envelope é gravado pronto: o evento publicado é exatamente o que foi
      decidido dentro da transação, não algo remontado depois a partir de campos soltos.
    */
    payload: toPublishedJson(message.payload),
    occurredAt: message.occurredAt,
    ...toOutboxUpdate(message),
  };
}
