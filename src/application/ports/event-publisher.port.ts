import type { OutboxMessage } from '../../domain/messaging/outbox-message';

/*
  Publicação de um evento de integração já comitado.

  Recebe a `OutboxMessage` inteira, e não só o payload, porque o agrupamento
  e a deduplicação são decididos a partir dela: o `aggregateId` é a wallet, e
  vira `MessageGroupId`; o `id` é o `eventId`, e vira
  `MessageDeduplicationId`. Passar só o corpo obrigaria o adapter a extrair
  esses dois campos do JSON, e a decisão sobre agrupamento sairia do lugar
  onde ela é explicável.

  Porta, e não o SDK direto, por uma razão prática: o caso de uso do worker é
  onde mora a ordem "publica, marca, comita", e essa ordem precisa ser
  testável sem um broker no ar.
*/
export interface IntegrationEventPublisher {
  publish(message: OutboxMessage): Promise<void>;
}

export const EVENT_PUBLISHER = 'EVENT_PUBLISHER';
