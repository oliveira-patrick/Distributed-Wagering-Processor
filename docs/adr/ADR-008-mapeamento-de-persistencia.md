# ADR-008 — Modelos de persistência separados e escrita explícita

- **Status:** Aceito e implementado
- **Data:** 2026-10-29 (status revisado em 2026-10-30)
- **Decidido por:** Patrick Oliveira

> Este ADR **revisa parte** do ADR-003. Lá, o "Unit of Work explícito" foi
> listado como uma das três primitivas que justificavam escolher o MikroORM.
> A escolha do MikroORM se mantém, e as outras duas razões se mantêm — mas o
> Unit of Work não é mais o mecanismo de escrita, e a razão está abaixo.

## Contexto

A seção 6.1 do enunciado exige que o domínio não dependa de tipo monetário de
ORM nem de decorator de framework. As entidades de domínio já estavam escritas
quando o mapeamento começou, e três fatos sobre elas moldaram a decisão:

- construtor **privado**, com criação por factory estática que valida
  invariantes;
- estado mutável em campos `_privados` atrás de getters;
- `Money` como value object com `bigint` interno, que na linha corresponde a
  uma coluna `numeric(20, 2)` mais a coluna de moeda **da linha** (ADR-007) —
  correspondência que não é um para um.

Em paralelo, a corretude deste sistema depende da **ordem** dos statements
dentro da transação, de três formas que o ADR-004 fixou:

1. a transação é inserida **antes** de qualquer consulta de duplicidade, para
   que a unicidade do schema decida o vencedor;
2. a wallet é lida **sob lock** e só então o saldo é decidido;
3. lançamento no ledger e evento na outbox entram no **mesmo** commit.

## Decisão

### Modelos de persistência separados

Uma classe por tabela em `infrastructure/persistence/entities/`, com campos
públicos e nenhuma invariante, mapeada com `EntitySchema`. A tradução para o
domínio fica em mappers explícitos, em `mappers/`.

O MikroORM mapeia essas classes, não as de domínio. Mapear as de domínio
exigiria que o ORM instanciasse sem passar pelo construtor e escrevesse nos
campos privados — isto é, afrouxar exatamente as barreiras que tornam as
invariantes estruturais em vez de convenção.

### Escrita explícita, não flush diferido

As escritas são `em.insert` e `em.nativeUpdate`, que vão ao banco no ponto da
chamada. Não há `persist` com flush no fim da transação.

A razão é a ordem. Com flush diferido, o SQL sai no fim da transação, numa
sequência escolhida pelo ORM, e as três propriedades acima deixam de ser
legíveis no código: a colisão de idempotência aconteceria no commit, quando já
é tarde para transformá-la em replay. Ordem implícita não se revisa.

### Toda leitura vai ao banco

Consequência direta da anterior, e descoberta por teste: `nativeUpdate` não
passa pelo Unit of Work e portanto **não atualiza o Identity Map**. Sem
`refresh`, uma leitura depois de uma escrita na mesma transação devolvia a
linha como ela estava antes — saldo velho. Toda leitura dos repositórios usa
`refresh: true`, concentrado na constante `FRESH`.

### Inserção que pode colidir vai em savepoint

No PostgreSQL, **qualquer** erro aborta a transação inteira: o statement
seguinte falha com "current transaction is aborted". A estratégia de "inserir
primeiro e tratar a colisão como replay" portanto não funciona sem isolamento,
porque a colisão mataria a transação em que a resposta de replay precisa ser
montada.

`tryInsertRow` isola a tentativa num `em.transactional` aninhado, que emite
`savepoint`. O rollback desfaz só a tentativa.

### Fronteira transacional como única porta

`UnitOfWork.run(work)` entrega os repositórios ao callback, construídos sobre
o `EntityManager` da transação. Fora de `run` não existe repositório. É o que
torna a atomicidade estrutural: não há como uma escrita escapar da transação
porque não há objeto com que fazê-la.

### O que o MikroORM continua dando

`transactional()` com savepoint aninhado; `LockMode.PESSIMISTIC_WRITE` para o
lock por wallet e `PESSIMISTIC_PARTIAL_WRITE` para o
`for update skip locked` da outbox; o pipeline de migrations; e o mapeamento de
colunas e tipos. São essas primitivas que sustentam o ADR-004 — não o Unit of
Work.

## Verificação

`test/integration/persistence-round-trip.spec.ts`, contra PostgreSQL 17.6
real: 27 casos, executados em 2026-10-30, 27 passando e 0 falhando. Cobrem o
`Money` no limite de 18 dígitos inteiros, os campos opcionais presentes e
ausentes, o `jsonb` do envelope, e o caso central — colisão de idempotência
seguida de leitura e commit bem-sucedidos na mesma transação, que é o que prova
o savepoint.

Dois dos achados acima vieram de falha de teste, não de revisão: a leitura
servida pelo Identity Map e o `causationId: undefined` que virava `null` no
`jsonb`.

## Consequências

**Positivas**

- O domínio não tem nenhum import de ORM, e as invariantes continuam
  estruturais: construtor privado e imutabilidade seguem valendo.
- O SQL de cada operação é legível na ordem em que aparece no caso de uso.
- O `tryInsert` devolve resultado em vez de exceção, e o caso de uso trata
  replay como caminho normal, sem conhecer savepoint nem código SQLSTATE.
- Ledger sem `save` e sem `delete`: a porta não oferece a operação, e o banco
  também recusa.

**Negativas**

- **Duas classes e um mapper por tabela.** Nada força os dois lados a
  concordarem; a sincronia depende do teste de round-trip e de revisão.
- Perde-se o agrupamento de escritas do Unit of Work: são mais idas ao banco
  por operação. Em troca, cada ida está onde se pode ver.
- `refresh: true` em toda leitura significa uma consulta por leitura, sem
  cache. É o comportamento desejado aqui — o saldo que importa é o comitado —,
  mas é custo real.
- O Identity Map fica praticamente sem uso, e quem esperar semântica de ORM
  vai se surpreender. A constante `FRESH` existe documentada por isso.
- O savepoint custa um par de statements por tentativa de inserção.
- **Contradiz parte do ADR-003.** Quem ler os dois em ordem precisa deste
  aviso para não achar que um deles está errado.

**Neutras**

- `em.insert` e `em.nativeUpdate` ainda passam pelo mapeamento de colunas do
  `EntitySchema`, então a decisão não é "SQL cru": é o ORM usado como
  construtor de query tipado e gerenciador de transação, não como camada de
  sincronização de objetos.

## Alternativas consideradas

**Mapear as classes de domínio direto, com `EntitySchema`.** Descartada.
`EntitySchema` já evita o decorator, mas não evita o resto: o ORM precisa
instanciar sem construtor e escrever em campo privado. O domínio passaria a ser
desenhado em torno do que o ORM consegue hidratar, que é o acoplamento que a
seção 6.1 quer impedir.

**Custom type do MikroORM para `Money`.** Era o que o `ARCHITECTURE.md` §3.2
previa. Descartada por duas razões: amarraria a reidratação de `Money` ao ORM,
quando ela precisa funcionar também na fila, na API e no payload da outbox; e
com uma moeda por linha (ADR-007) o tipo customizado teria de ler uma coluna
que não é dele, o que não é o que a abstração oferece.

**Unit of Work com linhas gerenciadas e um `WeakMap` ligando agregado a
linha.** Descartada depois de prototipada. Funciona, mas o savepoint de
`tryInsert` usa um `EntityManager` derivado, cuja linha inserida não fica
gerenciada pelo externo — então o `save` seguinte não emitiria `update`
nenhum. Resolver isso exigiria `merge` manual na volta do savepoint, o que é
mais mecanismo para revisar do que a escrita explícita inteira.

**SQL cru, sem entidades.** Descartada. Perderia `LockMode`, o savepoint
aninhado e a tipagem das colunas, que é justamente o que se usa do ORM. E
perderia o pipeline de migrations, que o ADR-003 escolheu por motivo próprio.

**Repositórios injetados direto no caso de uso, sem `UnitOfWork.run`.**
Descartada. Nada impediria uma escrita fora da transação, e as duas garantias
que mais dependem disso são as que o enunciado trata como eliminatórias.

## Revisitar quando

- O número de idas ao banco por operação aparecer na medição sob carga
  realista.
- A divergência entre modelo de domínio e modelo de persistência passar a
  custar mais do que o acoplamento que ela evita — o sinal seria mapper
  mudando em toda alteração de domínio, sem decisão nenhuma no meio.
- O MikroORM passar a permitir hidratar por factory estática, o que removeria
  a razão principal da separação.
