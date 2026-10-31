import { Money } from '../../../domain/money/money';

/*
  Contrato de representação monetária na persistência — explícito, num só
  lugar, e coberto por teste próprio.

  `Money.toJSON()` existe como rede de segurança, não como o mecanismo que
  define os contratos externos. Cada fronteira declara o seu: a coluna
  `numeric(20, 2)` recebe a string decimal canônica de escala 2, e a moeda
  vem da coluna `currency` da linha. Nomear a conversão aqui faz com que uma
  mudança em `toString()` quebre o teste deste contrato, em vez de mudar o
  formato gravado no banco sem ninguém notar.
*/

// Valor para a coluna `*_amount`.
export function toAmountColumn(money: Money): string {
  return money.toString();
}

// Reidrata a partir do par coluna de valor + moeda da linha.
export function toMoney(amount: string, currency: string): Money {
  return Money.from({ amount, currency });
}
