import { UniqueConstraintViolationException } from '@mikro-orm/core';

// `unique_violation` no PostgreSQL.
const UNIQUE_VIOLATION = '23505';

const MAX_DEPTH = 4;

interface DriverErrorShape {
  readonly code?: unknown;
  readonly constraint?: unknown;
  readonly cause?: unknown;
  readonly previous?: unknown;
}

/*
  O erro de topo raramente é o do driver: o MikroORM envolve, e o `pg`
  aparece mais abaixo em `cause` ou `previous`. Quem traz o nome da
  constraint é o erro do `pg`, e é dele que se descobre **qual** unicidade
  foi violada — informação que decide entre replay, conflito e reversão
  duplicada.
*/
function chain(error: unknown, depth = 0): readonly DriverErrorShape[] {
  if (depth > MAX_DEPTH || typeof error !== 'object' || error === null) {
    return [];
  }

  const node = error as DriverErrorShape;
  return [
    node,
    ...chain(node.cause, depth + 1),
    ...chain(node.previous, depth + 1),
  ];
}

export function isUniqueViolation(error: unknown): boolean {
  if (error instanceof UniqueConstraintViolationException) {
    return true;
  }

  return chain(error).some((node) => node.code === UNIQUE_VIOLATION);
}

// Nome da constraint violada, quando o driver o informa.
export function violatedConstraint(error: unknown): string | undefined {
  for (const node of chain(error)) {
    if (typeof node.constraint === 'string' && node.constraint !== '') {
      return node.constraint;
    }
  }
  return undefined;
}
