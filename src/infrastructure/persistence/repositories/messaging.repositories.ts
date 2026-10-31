import { LockMode } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';

import type { InboxRepository } from '../../../application/ports/inbox.repository';
import type {
  OutboxPendingStats,
  OutboxRepository,
} from '../../../application/ports/outbox.repository';
import type { InboxMessage } from '../../../domain/messaging/inbox-message';
import type { OutboxMessage } from '../../../domain/messaging/outbox-message';
import { inboxMessageSchema } from '../entities/inbox-message.row';
import { outboxMessageSchema } from '../entities/outbox-message.row';
import {
  toInboxDomain,
  toInboxRow,
  toInboxUpdate,
  toOutboxDomain,
  toOutboxRow,
  toOutboxUpdate,
} from '../mappers/messaging.mapper';
import { FRESH } from './read-options';
import { tryInsertRow } from './try-insert';

export class MikroOrmInboxRepository implements InboxRepository {
  constructor(private readonly em: EntityManager) {}

  async find(
    consumerName: string,
    messageId: string,
  ): Promise<InboxMessage | undefined> {
    const row = await this.em.findOne(
      inboxMessageSchema,
      { consumerName, messageId },
      FRESH,
    );
    return row === null ? undefined : toInboxDomain(row);
  }

  async tryInsert(message: InboxMessage): Promise<boolean> {
    const { inserted } = await tryInsertRow(
      this.em,
      inboxMessageSchema,
      toInboxRow(message),
    );
    return inserted;
  }

  async save(message: InboxMessage): Promise<void> {
    await this.em.nativeUpdate(
      inboxMessageSchema,
      { consumerName: message.consumerName, messageId: message.messageId },
      toInboxUpdate(message),
    );
  }
}

export class MikroOrmOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  /*
    Inserção direta, sem savepoint. A chave primária é o `eventId`, então uma
    colisão significaria o mesmo identificador gerado para dois eventos, ou o
    mesmo evento enfileirado duas vezes no mesmo fluxo — bug nos dois casos.
    Reexecutar uma transação revertida não colide: a linha anterior não
    existe.
  */
  async enqueue(message: OutboxMessage): Promise<void> {
    await this.em.insert(outboxMessageSchema, toOutboxRow(message));
  }

  /*
    `for update skip locked`, via `PESSIMISTIC_PARTIAL_WRITE`.

    É o que permite vários publicadores ao mesmo tempo sem lock global: cada
    um leva um lote disjunto, e quem chega depois pula as linhas já tomadas em
    vez de enfileirar atrás delas. Sem `skip locked`, dois publicadores
    serializariam na primeira linha pendente.

    `nextAttemptAt` nulo é "nunca tentado", logo vencido.
  */
  async claimDue(now: Date, limit: number): Promise<readonly OutboxMessage[]> {
    const rows = await this.em.find(
      outboxMessageSchema,
      {
        publishedAt: null,
        $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }],
      },
      {
        ...FRESH,
        lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE,
        orderBy: { occurredAt: 'asc', id: 'asc' },
        limit,
      },
    );

    return rows.map(toOutboxDomain);
  }

  async save(message: OutboxMessage): Promise<void> {
    await this.em.nativeUpdate(
      outboxMessageSchema,
      { id: message.id },
      toOutboxUpdate(message),
    );
  }

  /*
    Duas consultas, as duas pelo índice parcial de pendentes.

    Sem lock de propósito: é leitura para métrica, e tomar lock aqui faria a
    medição atrapalhar justamente o worker que ela observa.
  */
  async pendingStats(): Promise<OutboxPendingStats> {
    const pending = await this.em.count(outboxMessageSchema, {
      publishedAt: null,
    });

    if (pending === 0) {
      return { pending: 0 };
    }

    const oldest = await this.em.findOne(
      outboxMessageSchema,
      { publishedAt: null },
      { ...FRESH, orderBy: { occurredAt: 'asc' } },
    );

    return {
      pending,
      ...(oldest === null ? {} : { oldestOccurredAt: oldest.occurredAt }),
    };
  }
}
