import { LockMode } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';

import { TransactionConflict } from '../../../application/ports/wager-transaction.repository';
import type {
  TransactionInsertOutcome,
  WagerTransactionRepository,
} from '../../../application/ports/wager-transaction.repository';
import { InvariantViolationError } from '../../../domain/shared/invariant-violation-error';
import type { WagerTransaction } from '../../../domain/wagering/wager-transaction';
import { WagerTransactionStatus } from '../../../domain/wagering/wager-transaction-status';
import { wagerTransactionSchema } from '../entities/wager-transaction.row';
import {
  toWagerTransactionDomain,
  toWagerTransactionRow,
  toWagerTransactionUpdate,
} from '../mappers/wager-transaction.mapper';
import { FRESH } from './read-options';
import { tryInsertRow } from './try-insert';

/*
  De nome de constraint para significado de negócio.

  Os nomes são detalhe de schema e param aqui. Uma unicidade violada que não
  esteja neste mapa é erro de programação — alguém criou constraint sem
  decidir o que ela significa para quem chama —, e por isso levanta em vez de
  virar um desfecho genérico que o caso de uso teria de adivinhar.
*/
const CONFLICT_BY_CONSTRAINT: Readonly<Record<string, TransactionConflict>> = {
  wager_transactions_idempotency_key_unique: TransactionConflict.IdempotencyKey,
  wager_transactions_provider_external_unique:
    TransactionConflict.ProviderExternalId,
  wager_transactions_single_reversal_idx: TransactionConflict.AlreadyReversed,
};

export class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {}

  async tryInsert(
    transaction: WagerTransaction,
  ): Promise<TransactionInsertOutcome> {
    const attempt = await tryInsertRow(
      this.em,
      wagerTransactionSchema,
      toWagerTransactionRow(transaction),
    );

    if (attempt.inserted) {
      return { inserted: true };
    }

    const constraint = attempt.constraint;
    const conflict =
      constraint === undefined ? undefined : CONFLICT_BY_CONSTRAINT[constraint];

    if (conflict === undefined) {
      throw new InvariantViolationError(
        'Unicidade violada em wager_transactions sem significado mapeado: ' +
          (constraint ?? 'constraint não informada pelo driver'),
      );
    }

    return { inserted: false, conflict };
  }

  async save(transaction: WagerTransaction): Promise<void> {
    await this.em.nativeUpdate(
      wagerTransactionSchema,
      { id: transaction.id },
      toWagerTransactionUpdate(transaction),
    );
  }

  async findById(id: string): Promise<WagerTransaction | undefined> {
    const row = await this.em.findOne(wagerTransactionSchema, { id }, FRESH);
    return row === null ? undefined : toWagerTransactionDomain(row);
  }

  async findByIdempotencyKey(
    key: string,
  ): Promise<WagerTransaction | undefined> {
    const row = await this.em.findOne(
      wagerTransactionSchema,
      { idempotencyKey: key },
      FRESH,
    );
    return row === null ? undefined : toWagerTransactionDomain(row);
  }

  async findByProviderAndExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined> {
    const row = await this.em.findOne(
      wagerTransactionSchema,
      { providerId, externalTransactionId },
      FRESH,
    );
    return row === null ? undefined : toWagerTransactionDomain(row);
  }

  /*
    `skip locked` para que vários workers possam varrer a fila ao mesmo tempo
    sem pegar a mesma transação e sem esperar uns pelos outros.
  */
  async findDueForReference(
    now: Date,
    limit: number,
  ): Promise<readonly WagerTransaction[]> {
    const rows = await this.em.find(
      wagerTransactionSchema,
      {
        status: WagerTransactionStatus.PendingReference,
        nextReferenceAttemptAt: { $lte: now },
      },
      {
        ...FRESH,
        lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE,
        orderBy: { nextReferenceAttemptAt: 'asc', id: 'asc' },
        limit,
      },
    );

    return rows.map(toWagerTransactionDomain);
  }
}
