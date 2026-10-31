import type { Money } from '../../../domain/money/money';

export interface MoneyResponse {
  readonly amount: string;
  readonly currency: string;
}

/*
  Contrato de representação monetária na **saída HTTP**.

  Explícito, e não `Money.toJSON()` implícito. A serialização automática é
  rede de segurança: deixar a forma interna do value object definir o corpo da
  resposta faz com que qualquer mudança nele vire mudança de contrato público
  sem ninguém decidir isso. Com a conversão nomeada, a mudança quebra o teste
  deste presenter — que é onde ela deve aparecer.

  `amount` é string decimal de escala 2, nunca número: um `25.00` que vire
  `25` em JSON perde a escala, e um valor grande que vire `number` perde
  precisão, e isso não se admite em nenhuma fronteira.
*/
export function presentMoney(money: Money): MoneyResponse {
  return { amount: money.toString(), currency: money.currency };
}
