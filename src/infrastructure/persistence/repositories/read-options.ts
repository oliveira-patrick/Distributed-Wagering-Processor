import type { FindOptions } from '@mikro-orm/core';

/*
  Toda leitura vai ao banco, ignorando o Identity Map.

  Não é preferência de estilo — é correção. As escritas deste adapter são
  `insert` e `nativeUpdate` explícitos, que não passam pelo Unit of Work e
  portanto **não atualizam** o Identity Map. Sem `refresh`, uma leitura
  depois de uma escrita na mesma transação devolveria a linha como ela estava
  antes: saldo velho, status velho. Num caso de uso que decide a partir do que
  acabou de gravar, isso é a diferença entre um número certo e um errado.

  O custo é uma ida ao banco por leitura, o que é exatamente o que se quer
  aqui: o saldo que importa é o que está comitado, não o que um cache lembra.
*/
export const FRESH: Pick<FindOptions<never>, 'refresh'> = { refresh: true };
