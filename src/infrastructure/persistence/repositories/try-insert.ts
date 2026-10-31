import type { EntityName, RequiredEntityData } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';

import { isUniqueViolation, violatedConstraint } from './unique-violation';

export interface InsertAttempt {
  readonly inserted: boolean;
  // Nome da constraint violada quando `inserted` é `false`.
  readonly constraint: string | undefined;
}

/*
  Tenta inserir, isolando a tentativa num savepoint.

  O savepoint não é zelo excessivo: no PostgreSQL **qualquer** erro aborta a
  transação inteira, e o statement seguinte falha com "current transaction is
  aborted". Sem o isolamento, a estratégia de "inserir primeiro e tratar a
  colisão como replay" não teria como seguir lendo a transação original — a
  colisão mataria a transação em que a resposta precisa ser montada.

  `em.transactional` aninhado emite `savepoint`, e o rollback desfaz só a
  tentativa. A escrita é `insert` explícito, não `persist` com flush
  diferido, porque a colisão precisa acontecer **aqui**, e não no fim da
  transação quando já é tarde para transformá-la em replay.
*/
export async function tryInsertRow<T extends object>(
  em: EntityManager,
  entity: EntityName<T>,
  row: RequiredEntityData<T>,
): Promise<InsertAttempt> {
  try {
    await em.transactional(async (scoped) => {
      await scoped.insert(entity, row);
    });
    return { inserted: true, constraint: undefined };
  } catch (error) {
    if (!isUniqueViolation(error)) {
      throw error;
    }
    return { inserted: false, constraint: violatedConstraint(error) };
  }
}
