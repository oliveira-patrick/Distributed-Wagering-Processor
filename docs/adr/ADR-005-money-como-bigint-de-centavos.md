# ADR-005 — `Money` como `bigint` de centavos

- **Status:** Aceito e implementado
- **Data:** 2026-10-29(status revisado em 2026-10-30)
- **Decidido por:** Patrick Oliveira

## Contexto

A restrição 1 do enunciado é categórica: nunca `number`, `float` ou `double`
para dinheiro. Usá-los é falha eliminatória, e com razão — `0.1 + 0.2` em
IEEE-754 não dá `0.3`, e um ledger construído sobre isso deixa de fechar
sozinho depois de algumas milhares de operações.

A seção 6.1 define a superfície esperada de `Money`: `from`, `zero`, `add`,
`subtract`, `negate`, `isZero`, `isPositive`, `isNegative`, `isLessThan`,
`equals`, `toJSON`, `toString`. Nenhuma multiplicação, nenhuma divisão — o
domínio soma e subtrai valores que chegam prontos do provedor.

O enunciado **não** define intervalo monetário. Qualquer limite que o sistema
imponha é decisão do candidato, e precisa estar declarado como tal em vez de
escondido dentro de um quantificador de regex.

## Decisão

Internamente, `bigint` de centavos. Na fronteira, string decimal.

### Representação

- O valor é um `bigint` com o total em centavos, mais uma moeda ISO-4217 de
  três letras maiúsculas.
- `MONEY_SCALE = 2`: escala fixa de duas casas.
- `MAX_INTEGER_DIGITS = 18`, de onde sai
  `MAX_AMOUNT = "999999999999999999.99"`. O número espelha a coluna
  `numeric(20, 2)` — 20 dígitos no total, 2 depois do ponto. O limite é
  derivado da escolha de schema, não do enunciado, e as duas constantes são
  exportadas e nomeadas justamente para que a correspondência seja verificável
  e não acidental.
- `MAX_OPERATION_AMOUNT = "1000000000.00"` é um teto separado, para o contrato
  de entrada das operações. Uma aposta de um bilhão já é absurda; o tipo
  precisa representar saldos maiores que qualquer operação individual.

### Entrada

`Money.from` recebe `{ amount: string, currency: string }` e valida **antes**
de converter:

1. a moeda casa com `^[A-Z]{3}$` — minúscula é recusada, não normalizada;
2. `amount` é verificado com `typeof`, o que recusa número JSON antes que ele
   vire string por acidente;
3. `amount` casa com `^-?\d{1,18}(\.\d{1,2})?$`;
4. a parte fracionária é completada à direita e vira `bigint`.

Mais de duas casas decimais é **recusa**, nunca arredondamento implícito.
`"25"`, `"25.0"`, `"25.00"` e `"0025.00"` são todos aceitos e normalizados
para `"25.00"` — a normalização mora num lugar só, e nenhum endpoint
reimplementa a sua.

### Sinal

`Money` representa negativos, porque `negate()` e a diferença da reconciliação
precisam deles. A restrição de sinal pertence ao **contrato da operação**, não
ao tipo: `WagerTransaction.create` recusa valor não positivo,
`WalletLedgerEntry.create` idem, e o schema repete a regra em `check`.

### Fronteiras

`toJSON()` existe como rede de segurança, **não** como o mecanismo que define
os contratos externos. Cada fronteira declara o seu, explicitamente e com
teste próprio: a persistência em
`infrastructure/persistence/mappers/money.column.ts`, a outbox em
`toPublishedJson`, e a API no presenter de F4. Deixar a serialização
automática definir todos eles acoplaria o formato publicado à forma interna do
objeto.

### Premissas de escopo

- **Moeda única `BRL`.** O modelo é multi-moeda — a moeda viaja em todo valor
  e operações entre moedas diferentes lançam erro de domínio —, mas nada no
  sistema converte entre moedas.
- **Escala fixa de 2.** Vale para `BRL`, `USD` e `EUR`; não vale para `JPY`
  (expoente 0) nem `BHD` (expoente 3).

## Consequências

**Positivas**

- Exatidão sem dependência nova: `bigint` é precisão arbitrária e nativo. O
  enunciado pede para não introduzir tecnologia sem necessidade demonstrável,
  e aqui ela não existe.
- O domínio nunca multiplica nem divide, então **nenhum arredondamento
  acontece em lugar nenhum**. Não há política de arredondamento para
  documentar porque não há arredondamento.
- Fechado sob soma, subtração e negação: o resultado de uma operação entre
  dois `Money` válidos é sempre um `Money` válido, ou uma exceção explícita no
  overflow.
- `numeric(20, 2)` no banco e `bigint` de centavos na memória fazem a mesma
  conta. A reconciliação pode somar o ledger dentro do PostgreSQL sem divergir
  da soma feita em memória — provado por teste de integração.

**Negativas**

- A escala fixa é uma limitação real: uma moeda de expoente diferente exige
  que a unidade mínima passe a depender da moeda, o que muda `Money`, as
  colunas e os contratos de fronteira.
- O limite de 18 dígitos inteiros vem do schema, não do negócio. Se algum dia
  o schema mudar, o domínio tem de mudar junto — a relação está documentada,
  mas não é verificada por compilador.
- `bigint` não é serializável por `JSON.stringify`, o que obriga a conversão
  explícita em toda fronteira. É um custo recorrente, e o lado bom é que torna
  impossível vazar a representação interna por descuido.
- Cada fronteira com contrato próprio significa mais um teste por fronteira,
  em vez de um teste de `toJSON` que valeria para todas.

**Neutras**

- Comparar `Money` de moedas diferentes tem dois comportamentos de propósito:
  `equals` devolve `false`, porque perguntar se um real é igual a um dólar tem
  resposta; `add`, `subtract` e `isLessThan` lançam, porque somar os dois não
  tem.

## Alternativas consideradas

**Biblioteca decimal (`decimal.js`, `big.js`, `dinero.js`).** Descartada.
Resolveria o mesmo problema com uma dependência a mais, e a parte que
justificaria a biblioteca — arredondamento, multiplicação, divisão, câmbio —
não existe neste domínio. `dinero.js` traria também o seu próprio modelo de
moeda, que teria de ser reconciliado com o do enunciado.

**`number` guardando centavos inteiros.** Descartada. É exato apenas até
2^53−1, cerca de 90 trilhões de centavos, e nada no tipo impede que uma
divisão acidental produza fração. O enunciado proíbe `number` para dinheiro
sem abrir exceção para "centavos inteiros", e a proibição é mais fácil de
auditar quando não tem exceção.

**String decimal com aritmética manual.** Descartada. É `bigint` reinventado,
com mais código para revisar e os mesmos casos de borda.

**Custom type do MikroORM fazendo a conversão.** Descartada como mecanismo
principal — ver ADR-008. O tipo customizado amarraria a reidratação ao ORM, e
a conversão de `Money` precisa funcionar também em fronteiras onde não há ORM
nenhum: a fila, a API e o payload da outbox.

**Guardar `amount` e `currency` num tipo composto do PostgreSQL.**
Descartada. `numeric` em coluna própria permite `sum` e comparação dentro do
banco, que é o que a reconciliação precisa fazer sobre o ledger inteiro sem
trazer todas as linhas para a aplicação.

## Revisitar quando

- Entrar no escopo uma moeda com expoente diferente de 2 — `JPY`, `BHD`,
  `KWD`. A unidade monetária mínima passa a depender da moeda, e a escala fixa
  deixa de valer.
- O domínio passar a multiplicar ou dividir: taxa percentual, rake, conversão
  cambial, rateio. Aí aparece arredondamento, e junto com ele a necessidade de
  uma política declarada e testada.
- O limite de 18 dígitos inteiros se mostrar apertado, o que implicaria
  revisitar também o `numeric(20, 2)` do schema.
