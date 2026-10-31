# ADR-007 — Uma moeda por linha, não uma por valor monetário

- **Status:** Aceito e implementado
- **Data:** 2026-10-29 (status revisado em 2026-10-30)
- **Decidido por:** Patrick Oliveira

## Contexto

A seção 6.1 do enunciado permite as duas formas: "na persistência, valor e
moeda podem ocupar colunas separadas, desde que a representação seja exata e
reidratada como `Money`". "Colunas separadas" quer dizer não guardar
`"25.00 BRL"` num campo de texto — não diz quantas colunas de moeda cada linha
tem.

A decisão anterior, registrada no `ARCHITECTURE.md` §3.2 como **decidida e não
implementada**, era duas colunas por valor: cada `Money` com o seu `*_amount` e
o seu `*_currency`. O schema tem seis valores monetários em três tabelas —
`wallets.balance`; `wager_transactions.money` e `observedBalance`;
`wallet_ledger_entries.money`, `balanceBefore` e `balanceAfter`.

Na hora de escrever a migration, duas coisas pesaram contra aquela forma.

A primeira é que a seção 6.2 modela `Wallet` com `currency` como campo
próprio, separado do saldo. Pela regra de duas colunas, a linha teria
`currency` **e** `balance_currency`, duas colunas que não podem divergir.

A segunda é mais forte, e vale para o ledger: um lançamento move um valor numa
moeda, com saldo antes e depois **na mesma** moeda. Isso é a definição de
lançamento, não uma simplificação de escopo. As três colunas de moeda de uma
linha do ledger nunca poderão guardar valores diferentes.

## Decisão

Uma coluna `currency char(3)` por linha, compartilhada por todos os valores
monetários dela.

```
wallets                currency, balance_amount
wager_transactions     currency, money_amount, observed_balance_amount
wallet_ledger_entries  currency, money_amount,
                       balance_before_amount, balance_after_amount
```

Nove colunas monetárias onde a forma anterior teria treze.

E, como `wallets` passa a ter `(id, currency)` único, a coerência de moeda
entre a wallet e o que a referencia vira **foreign key**:

```sql
foreign key ("wallet_id", "currency") references "wallets" ("id", "currency")
```

Uma transação ou um lançamento em moeda diferente da wallet é recusado pelo
banco, sem nenhum `check` de igualdade entre colunas.

A invariante de linha é implícita no schema, então está declarada onde ela
vive: `comment on column wallet_ledger_entries.currency`.

## Consequências

**Positivas**

- **Linha com moedas internas divergentes deixa de ser representável.** Na
  forma anterior esse estado existia e precisaria de `check` extra para ser
  excluído — quatro deles, somando `wallets`, `wager_transactions` e o ledger.
- O `check` aritmético do lançamento se sustenta sozinho. Com duas colunas por
  valor ele compararia três `numeric` sem saber se são da mesma moeda, e
  precisaria de uma constraint companheira de igualdade de moeda para não ser
  vazio. Duas constraints para expressar uma invariante.
- A coerência wallet ↔ transação ↔ lançamento é uma única foreign key. Na
  forma anterior seriam três, uma por valor, ou uma mais o `check` interno.
- **Elimina uma classe de bug invisível na nossa suíte.** Com 2N campos, o
  mapper pode trocar `balance_before_currency` por `balance_after_currency`: o
  código compila, o typecheck passa e todos os testes passam, porque tudo é
  `BRL`. Com uma moeda por linha o erro não existe — há uma moeda, lida uma
  vez, entregue a todos os `Money.from` da linha.
- `observed_balance_amount` é anulável sem precisar de coluna de moeda
  emparelhada, e portanto sem `check` de nulidade conjunta.
- Quatro colunas `char(3)` a menos numa tabela — o ledger — que só cresce.

**Negativas**

- **Desvia do `ARCHITECTURE.md` §3.2**, que foi reescrito junto com esta
  decisão. Um leitor que conheça a versão anterior do documento vai estranhar.
- A invariante "todos os valores da linha compartilham a moeda" é **implícita
  no schema**. Nada impede alguém de acrescentar um valor monetário em outra
  moeda à linha sem notar a premissa. A mitigação é o comentário na coluna e
  este ADR; não há constraint que force.
- Se algum campo específico vier a precisar de moeda própria, aquele campo
  passa a ser exceção à regra da linha — mais confuso de ler do que um schema
  uniformemente de duas colunas.
- Não encaixa naturalmente em embeddables do MikroORM, que são a forma nativa
  de mapear um value object de duas colunas. Aqui o custo é zero porque o
  mapeamento é feito à mão (ver ADR-008), mas deixa de ser zero se essa
  decisão for revista.

**Neutras**

- O custo de implementação do mapeamento é o mesmo nas duas formas:
  `Money.from({ amount: row.moneyAmount, currency: row.currency })` e
  `Money.from({ amount: row.moneyAmount, currency: row.moneyCurrency })` são a
  mesma linha de código.
- Moedas diferentes entre wallets — uma wallet `BRL` e uma `USD` para o mesmo
  player — já funcionam hoje, nas duas formas, sem migration. O índice único é
  `(player_id, currency)`, e há teste de integração para isso.

## Alternativas consideradas

**Duas colunas por valor monetário**, como o §3.2 original previa.
Descartada. O argumento a favor é estar "pronta para multi-moeda", e ele não
se sustenta quando os cenários são separados:

- _Moedas diferentes entre wallets, uma por wallet._ As duas formas já
  atendem hoje, sem migration. Nenhuma vantagem.
- _Moedas diferentes dentro de uma wallet._ Exige dois saldos, logo uma tabela
  `wallet_balances` com chave `(wallet_id, currency)` e uma nova fronteira de
  agregado. Mudança de modelo, não de coluna. Nenhuma vantagem.
- _Conversão cambial._ Exige ledger de duas pernas. Nenhuma das formas
  prepara. Nenhuma vantagem.
- _Expoentes diferentes por moeda._ É a questão da escala, tratada no ADR-005.
  Trabalho idêntico nas duas formas.

E a migração é assimétrica a favor desta decisão: se um campo específico
precisar de moeda própria, `alter table add column fee_currency char(3)` com
backfill a partir de `currency` é barato, local, e feito no momento em que o
requisito aparece. O caminho inverso é um `drop column` que só se faz depois de
provar que os dados sempre foram redundantes — isto é, depois de ter carregado
o custo por nada.

**Um tipo composto do PostgreSQL por valor monetário.** Descartada no ADR-005:
`numeric` em coluna própria é o que permite `sum` e comparação dentro do banco,
que é o que a reconciliação precisa.

**Uma tabela `wallet_balances` com chave `(wallet_id, currency)` desde já.**
Descartada. É a forma correta para wallet multi-moeda, e o enunciado permite
assumir moeda única. Introduzir a fronteira de agregado agora custaria
complexidade sem requisito — e o critério de modelagem da seção 12 inclui
simplicidade.

## Revisitar quando

- Uma wallet precisar manter saldo em mais de uma moeda ao mesmo tempo. Aí a
  mudança não é de coluna: é a tabela `wallet_balances` descrita acima.
- Algum valor monetário de uma linha precisar de moeda diferente dos outros —
  por exemplo uma taxa cobrada em outra moeda. Nesse caso acrescenta-se a
  coluna de moeda **daquele** campo, e este ADR passa a ter uma exceção
  declarada.
- Entrar conversão cambial no escopo, que muda o modelo do ledger antes de
  mudar o das colunas.
