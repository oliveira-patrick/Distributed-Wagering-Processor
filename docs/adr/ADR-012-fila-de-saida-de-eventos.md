# ADR-012 — Fila de saída dos eventos, agrupamento e deduplicação

- **Status:** Aceito e implementado
- **Data:** 2026-10-30
- **Decidido por:** Patrick Oliveira

## Contexto

A seção 10 do enunciado nomeia duas filas, e as duas são de **entrada**:

```
wager-transactions.fifo
wager-transactions-dlq.fifo
```

A seção 11 exige que um worker publique os eventos de integração pendentes da
outbox — `WagerTransactionProcessed`, `WagerTransactionRejected`,
`WalletBalanceChanged` e `WagerTransactionPendingReference` — e descreve o
cenário de recuperação que esse worker precisa atender. Mas não diz **para
onde** esses eventos vão.

A lacuna é real e precisa de decisão: sem destino, o publicador não existe, e
sem publicador a outbox é uma tabela que só cresce.

## Decisão

Uma **fila de saída própria**, com DLQ própria:

```
wagering-events.fifo
wagering-events-dlq.fifo
```

Declaradas em `queue-topology.ts` junto com as de entrada, criadas pelo
`scripts/bootstrap-queues.ts`, e nomeadas no contrato de ambiente como
`SQS_EVENTS_QUEUE_NAME` e `SQS_EVENTS_DLQ_NAME` — com o mesmo sufixo `.fifo`
validado na inicialização.

### Por que não a fila de entrada

A fila de entrada carrega **comandos**: `WagerTransactionRequested`, um pedido
para que algo aconteça. Os eventos de integração são **fatos**: algo
aconteceu. Publicar fato numa fila de comando tem uma consequência mecânica
imediata — o consumidor da seção 10 lê aquela fila, e passaria a receber de
volta os eventos que ele mesmo causou.

Isso obrigaria o consumidor a filtrar por `type` e descartar o que não
reconhece. Três problemas com isso, em ordem de gravidade: cada evento
publicado viraria uma entrega extra a processar e descartar; um erro de
filtro produziria reprocessamento de operação financeira; e a fila passaria
a ter dois contratos de payload, com o `maxReceiveCount` e o visibility
timeout dimensionados para um deles.

### `MessageGroupId` = `aggregateId`, que é a `walletId`

Todos os quatro eventos usam a `walletId` como `aggregateId`, e é ela que vai
no grupo. O grupo é a unidade de ordenação do SQS FIFO, e a wallet é a unidade
de concorrência e a fronteira de consistência do domínio — as duas coisas
coincidem, e é por isso que a escolha é essa.

Com o `eventId` no lugar, cada evento viraria o próprio grupo e a ordenação
relativa entre eventos da mesma wallet se perderia: um consumidor que
reconstrói saldo a partir dos eventos poderia ver o crédito antes do débito.

### `MessageDeduplicationId` = `id` da outbox, que é o `eventId`

É o que torna inofensiva a republicação descrita no
[ADR-013](ADR-013-modelo-de-execucao-dos-workers.md): o publicador envia e
depois marca, e entre as duas coisas o processo pode morrer. Reexecutando,
o mesmo evento é enviado de novo — e dentro da janela de cinco minutos do
broker a duplicata não chega ao consumidor.

Fora da janela ela chega, e aí quem recusa é o inbox persistente de quem
consome. A deduplicação por conteúdo fica **desligada** na topologia
justamente para que este id explícito seja o critério: dois eventos legítimos
podem ter corpos idênticos — dois `LOSS` de mesmo valor na mesma rodada, por
exemplo.

### A DLQ da fila de saída

Tem papel diferente da DLQ de entrada. Nós não consumimos a fila de eventos;
quem consome é outro sistema. A DLQ existe para que um evento que **nenhum**
consumidor externo consiga processar saia do caminho rápido em vez de ficar
sendo reentregue para sempre. É infraestrutura para quem assina, não para nós.

## Verificação

Contra MiniStack real, em `test/integration/outbox-publisher.spec.ts`:

- os eventos gravados no commit são publicados, e a linha é marcada;
- a linha publicada **não** é apagada — a outbox continua auditável;
- toda mensagem publicada carrega `MessageGroupId` igual à `walletId`, e o
  conjunto de `MessageDeduplicationId` é exatamente o conjunto de `eventId`
  das linhas;
- o corpo publicado é o envelope gravado dentro da transação, não algo
  remontado depois;
- um evento deixado pendente por um processo que morreu é publicado por quem
  vem depois.

E em `test/concurrency/recovery.spec.ts`, com dois workers de verdade: 200
eventos pendentes são publicados sem perda, e o `/metrics` de cada processo
mostra que os dois publicaram — um split observado de 100 e 102.

O `bun run queues:bootstrap` cria os quatro recursos e é idempotente; o
`bun run infra:check` lê de volta `FIFO=true` e a `RedrivePolicy` das **duas**
filas principais.

## Consequências

**Positivas**

- Comando e evento ficam em canais separados, com contratos separados. O
  consumidor da seção 10 só recebe o que foi feito para ele.
- A republicação depois de uma queda é segura sem nenhum trabalho extra do
  nosso lado: é o `MessageDeduplicationId` do broker mais o inbox de quem
  consome.
- A ordenação por wallet atravessa o sistema inteiro: o `MessageGroupId` da
  entrada, o lock de linha no PostgreSQL e o `MessageGroupId` da saída são
  todos a `walletId`.
- Um consumidor externo pode ser adicionado sem tocar em nada: a fila existe,
  é FIFO e tem DLQ.

**Negativas**

- **Duas filas a mais para provisionar**, e duas variáveis de ambiente a mais,
  nenhuma delas prevista no enunciado. Quem for avaliar precisa rodar o
  `queues:bootstrap`, que já era necessário, mas agora cria quatro recursos.
- Nada consome a fila de saída neste projeto. Ela acumula até a retenção de
  quatro dias expirar, e um avaliador que olhe o emulador vai encontrar
  mensagens paradas. É o comportamento correto de um produtor de eventos, e
  ainda assim parece lixo acumulado para quem não sabe.
- A DLQ de eventos nunca vai receber nada por nossa causa — só por conta de um
  consumidor externo que não existe. Hoje ela é infraestrutura sem uso.
- A `walletId` como grupo serializa a entrega de eventos de uma wallet
  movimentada. Para o consumidor, é o preço da ordenação que ele ganha.

**Neutras**

- O publicador resolve a URL da fila na primeira publicação, não na
  construção, pela mesma razão do `connect: false` do MikroORM: o worker sobe
  com o SQS fora do ar e reporta readiness indisponível, em vez de morrer na
  inicialização.
- A escolha do nome `wagering-events` não vem do enunciado. Qualquer outro
  serviria; o que importa é não ser a fila de entrada.

## Alternativas consideradas

**Publicar na fila de entrada.** Descartada. O consumidor passaria a receber
os próprios eventos e a precisar filtrá-los, com os três problemas listados
acima.

**Fila de saída sem DLQ.** Descartada por pouco. A DLQ é barata — uma fila a
mais no bootstrap — e sem ela um evento que nenhum consumidor consegue
processar fica em reentrega indefinida, consumindo capacidade de quem assina.

**Um tópico SNS com fan-out para filas por assinante.** Descartada: o
enunciado restringe a mensageria a SQS, e introduzir SNS acrescenta um serviço
ao `docker-compose.yml` para resolver um problema — múltiplos assinantes — que
este escopo não tem.

**Uma fila por tipo de evento.** Descartada. Quatro filas mais quatro DLQs
para quatro tipos que compartilham o mesmo envelope e o mesmo agrupamento. E
quebraria a ordenação entre eventos da mesma wallet, que é justamente o que o
FIFO por `walletId` existe para dar.

**Não publicar, e deixar a outbox como trilha de auditoria.** Descartada por
contrariar a seção 11 diretamente, que exige o worker publicador e descreve o
cenário de recuperação dele.

## Revisitar quando

- Aparecer um consumidor externo de verdade. Aí o contrato do envelope passa a
  ter outra ponta, e a versão dos eventos — que já existe no envelope — começa
  a importar.
- Surgirem vários assinantes com interesses diferentes. Nesse ponto SNS com
  fan-out passa a pagar o serviço adicional.
- O volume de eventos de uma única wallet tornar a serialização por grupo um
  gargalo para quem consome. Aí vale separar os eventos que não precisam de
  ordem relativa — `WagerTransactionRejected`, por exemplo — em outro grupo.
