/*
  Reduz um erro desconhecido a uma linha legível.

  Erros de driver e de SDK costumam trazer a informação útil na `cause`, não
  na mensagem de topo — e alguns chegam com mensagem vazia, o que produz um
  health check que diz "down" sem dizer por quê. Esta função percorre a
  cadeia de causas para que o motivo apareça.
*/
export function describeError(error: unknown, depth = 0): string {
  const MAX_DEPTH = 4;

  /*
    Falhas de conexão em Node chegam como AggregateError: uma tentativa por
    família de endereço (IPv4 e IPv6). A causa real está em `errors`, não em
    `cause`, e a mensagem de topo vem vazia.
  */
  if (error instanceof AggregateError && depth < MAX_DEPTH) {
    const inner = error.errors as readonly unknown[] | undefined;
    if (inner !== undefined && inner.length > 0) {
      const first = describeError(inner[0], depth + 1);
      const extra = inner.length > 1 ? ` (+${String(inner.length - 1)})` : '';
      return `${error.name}: ${first}${extra}`;
    }
  }

  if (error instanceof Error) {
    const head = [error.name, error.message]
      .filter((part) => part !== '')
      .join(': ');

    const cause: unknown = error.cause;
    if (cause !== undefined && cause !== null && depth < MAX_DEPTH) {
      return `${head} (causa: ${describeError(cause, depth + 1)})`;
    }
    return head === '' ? `${error.name || 'Error'} sem mensagem` : head;
  }

  if (typeof error === 'string') {
    return error === '' ? 'erro sem mensagem' : error;
  }

  if (typeof error === 'object' && error !== null) {
    try {
      return JSON.stringify(error);
    } catch {
      return Object.prototype.toString.call(error);
    }
  }

  return String(error);
}
