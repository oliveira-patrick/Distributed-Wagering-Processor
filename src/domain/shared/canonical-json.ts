import { createHash } from 'node:crypto';

/*
  Serialização canônica: a mesma estrutura sempre produz a mesma string.

  `JSON.stringify` não serve para hash porque a ordem das chaves segue a
  ordem de inserção do objeto — e dois payloads com os mesmos campos em ordem
  diferente produziriam hashes diferentes, transformando um reenvio legítimo
  em `IDEMPOTENCY_CONFLICT`. O hash precisa de JSON canônico, com chaves
  ordenadas, justamente por isso.

  Regras:

  - chaves de objeto ordenadas por code point (`Array.prototype.sort` padrão);
  - chave com valor `undefined` é omitida, de modo que ausência e
    `undefined` explícito dão o mesmo resultado;
  - arrays preservam a ordem, que neles é significativa;
  - sem espaços em branco entre tokens.
*/
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));

    const body = entries
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',');

    return `{${body}}`;
  }

  if (typeof value === 'bigint') {
    /*
      Nunca deveria chegar aqui: dinheiro atravessa a fronteira como string
      decimal. Falhar alto é melhor que gravar um hash sobre um número que o
      JSON.stringify recusaria do outro lado.
    */
    throw new TypeError(
      'bigint não é serializável em JSON canônico; converta para string decimal',
    );
  }
  /*
    `undefined` só chega aqui dentro de array — como chave de objeto ele é
    filtrado antes. `JSON.stringify(undefined)` devolveria `undefined`, que
    não é JSON válido no meio de uma lista.
  */
  if (value === undefined) return 'null';

  return JSON.stringify(value);
}

// SHA-256 em hexadecimal minúsculo. 64 caracteres.
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}
