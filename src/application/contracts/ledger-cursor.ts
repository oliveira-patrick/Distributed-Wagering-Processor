/*
  Cursor do extrato: estável e opaco.

  **Keyset**, não offset. Com `offset`/`limit`, uma transação concorrente
  inserida no meio da paginação faz a página seguinte repetir ou pular um
  lançamento, porque a posição numérica mudou. O ledger é append-only e
  ordenado por `(created_at, id)`, então guardar a última chave lida dá uma
  posição que nenhuma inserção futura invalida — é o que "estável" significa.

  O `id` entra no par para desempatar lançamentos com o mesmo instante, o que
  acontece de verdade: todos os lançamentos da mesma transação compartilham o
  `now` do caso de uso.

  **Opaco** é base64url de um JSON mínimo. Não é segredo nem assinatura — é um
  contrato que diz "não interprete isto", para que a forma interna da
  paginação possa mudar sem quebrar quem guardou um cursor.
*/
export interface LedgerCursor {
  readonly createdAt: Date;
  readonly id: string;
}

interface EncodedCursor {
  readonly t: string;
  readonly i: string;
}

export function encodeLedgerCursor(cursor: LedgerCursor): string {
  const payload: EncodedCursor = {
    t: cursor.createdAt.toISOString(),
    i: cursor.id,
  };

  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/*
  `undefined` para cursor ilegível.

  Quem decide o que fazer com isso é o caso de uso: cursor inválido é payload
  inválido, e vira `VALIDATION_FAILED`. Devolver a primeira página em silêncio
  esconderia um erro de integração do cliente.
*/
export function decodeLedgerCursor(raw: string): LedgerCursor | undefined {
  try {
    const decoded: unknown = JSON.parse(
      Buffer.from(raw, 'base64url').toString('utf8'),
    );

    if (typeof decoded !== 'object' || decoded === null) {
      return undefined;
    }

    const { t, i } = decoded as Partial<EncodedCursor>;
    if (typeof t !== 'string' || typeof i !== 'string') {
      return undefined;
    }

    const createdAt = new Date(t);
    if (Number.isNaN(createdAt.getTime())) {
      return undefined;
    }

    return { createdAt, id: i };
  } catch {
    return undefined;
  }
}
