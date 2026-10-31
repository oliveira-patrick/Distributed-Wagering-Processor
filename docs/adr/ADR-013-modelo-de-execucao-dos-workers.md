# ADR-013 — Modelo de execução dos workers

- **Status:** Aceito e implementado
- **Data:** 2026-10-30
- **Decidido por:** Patrick Oliveira

## Contexto

Três trabalhos de fundo precisam rodar continuamente:

1. o **consumidor** da fila de entrada (seção 10);
2. o **publicador da outbox** (seção 11);
3. o **worker de referência pendente** (seção 7.1).

O [ADR-001](ADR-001-camadas-em-aplicacao-nestjs.md) já decidiu que são papéis
da mesma aplicação, escolhidos pelo entrypoint. O que faltava decidir é como
cada um dá as suas passadas, como coordenam entre instâncias, e como param.

Três perguntas concretas, e nenhuma com resposta óbvia:

- a API e os workers sobem no mesmo processo ou em processos distintos?
- cada worker é um processo, ou os três compartilham um?
- a passada de um worker trata um item ou um lote, e numa transação ou em
  várias?

## Decisão

### Dois entrypoints: `src/main.ts` e `src/worker.ts`

A API num processo; os três trabalhos de fundo noutro.

**Por que os workers não sobem junto com a API.** Um processo que atende
requisições de negócio _e_ publica eventos tem os dois competindo pelo mesmo
event loop e pelo mesmo pool de conexões. Uma rajada de apostas atrasaria a
publicação de eventos, e um lote grande de outbox atrasaria as apostas — e
nenhum dos dois sintomas aponta para a causa.

**Por que os três trabalhos compartilham um processo.** Separá-los em três
seria a decisão certa se cada um precisasse de escala própria, e hoje nenhum
precisa: os três são limitados pelo mesmo PostgreSQL, e nenhum deles satura
um processo sozinho. A costura para separá-los existe e é o
`WorkersModule` — tirar um provider de lá e dar-lhe um entrypoint é o trabalho
inteiro.

O processo de worker **também** sobe `/health` e `/metrics`, em porta própria
(`WORKER_PORT`). Sem a sonda, um worker travado é indistinguível de um worker
ocioso; sem `/metrics`, as métricas que só ele produz — outbox lag, retries,
DLQ — não têm por onde sair.

### `PollingLoop`: uma passada, e um `sleep` que acorda

O publicador e o worker de referência compartilham o mesmo laço, extraído
porque a parte difícil dele não é o laço:

```ts
while (rodando) {
  const desfecho = await tick();
  if (desfecho === 'idle') await sleep(intervalo); // interrompível
}
```

Duas propriedades valem o código:

- **`again` não dorme.** Lote cheio sugere que há mais trabalho vencido, e
  esperar o intervalo nesse caso transformaria uma fila acumulada em latência
  artificial.
- **o `sleep` acorda no shutdown.** Um `setTimeout` comum de cinco segundos
  faria um worker ocioso levar cinco segundos para encerrar. Com dois workers
  assim, o prazo de dez segundos que o Compose dá entre `SIGTERM` e `SIGKILL`
  já é insuficiente.

O consumidor **não** usa o `PollingLoop`: o long poll de vinte segundos do
`ReceiveMessage` já é a espera, e ele é cancelado por `AbortSignal` no
shutdown — ver [ADR-011](ADR-011-consumidor-sqs-e-inbox-transacional.md).

### Publicador da outbox: um lote, uma transação

```
begin
  claimDue(limite)      -- for update skip locked
  para cada evento:
    publica no SQS
    marca como publicado   (ou agenda retry, se falhar)
commit
```

A coordenação entre instâncias é o `for update skip locked`: cada publicador
leva um lote disjunto, e quem chega depois pula as linhas tomadas em vez de
enfileirar atrás delas. Sem lock distribuído e sem eleição de líder.

**A janela de republicação é aceita de propósito.** Entre o `SendMessage` que
deu certo e o `commit` existe um instante em que o processo pode morrer. Se
morrer ali, a linha continua pendente e outra instância publica o evento de
novo.

A alternativa — marcar antes de publicar — fecharia a janela de duplicação e
abriria a de **perda**. A seção 3 lista "perder eventos confirmados" como
invariante global violada, enquanto a seção 11 diz com todas as letras que
"uma publicação duplicada continua segura para o consumidor". A escolha é
dessas duas assimetrias, não de preferência.

A falha de um evento não derruba o lote: o `catch` é por evento, quem falhou
recebe backoff, e os outros seguem. Com a exceção subindo, a transação inteira
reverteria e os eventos já publicados seriam republicados à toa, com a
contagem de tentativas nunca avançando.

### Worker de referência: um item, uma transação

Aqui é o inverso do publicador, e por duas razões.

**Isolamento.** Uma transação recusada por violação de constraint aborta a
transação SQL inteira no PostgreSQL. Num lote compartilhado, uma transação
problemática levaria consigo as outras dezenove.

**Duração.** Aplicar o efeito tardio exige o lock da wallet. Um lote inteiro
numa transação só manteria vinte wallets travadas enquanto a API espera por
elas.

O custo é uma ida ao banco por item em vez de uma por lote, e ele é
irrelevante para um worker cuja menor espera de agenda é de onze minutos.

A ordem dentro da transação é **lock da wallet primeiro**, igual ao caminho de
submissão. Inverter aqui — travar a transação antes da wallet — criaria
deadlock entre o worker e a API, cada um esperando o lock que o outro tem.

### Encerramento

Todos os três respondem a `onApplicationShutdown`, que só roda porque o
entrypoint chama `enableShutdownHooks()`. O prazo é
`WORKER_SHUTDOWN_TIMEOUT_MS`, com default de 8 s — abaixo dos 10 s que o
Compose dá por padrão, e o serviço `worker` do Compose declara
`stop_grace_period: 20s` para dar folga.

## Verificação

- `test/integration/outbox-publisher.spec.ts` — publicação, marcação,
  recuperação de evento órfão, duas passadas concorrentes com conjuntos
  publicados **disjuntos**, e o gauge de lag.
- `test/integration/pending-reference.spec.ts` — o worker aplica o efeito
  quando a referência aparece, conta a tentativa quando ela não vem, e recusa
  com `REFERENCE_NOT_FOUND` ao esgotar a agenda.
- `test/concurrency/recovery.spec.ts` — dois workers de verdade publicando
  200 eventos sem perda, com o `/metrics` de cada processo provando que os
  dois trabalharam; e um worker morto com `SIGKILL` no meio de 40 mensagens,
  com o substituto terminando o trabalho sem duplicar nada.
- `test/unit/sqs-consumer.spec.ts` — o `stop` termina dentro do prazo em vez
  de esperar o long poll.

## Consequências

**Positivas**

- API e trabalho de fundo não competem. Uma rajada num não aparece como
  latência no outro.
- Nenhuma coordenação externa: nem Redis para lock, nem eleição de líder. A
  coordenação é o `skip locked`, que o PostgreSQL já dá.
- O worker é observável como qualquer serviço: tem readiness e tem métricas.
- O laço compartilhado significa que corrigir o encerramento corrige os dois
  workers de uma vez.

**Negativas**

- **Os três trabalhos escalam juntos e caem juntos.** Se o consumo da fila
  passar a exigir escala própria, é preciso fazer a separação que esta decisão
  adiou.
- **Publicação duplicada é possível**, e o sistema depende do
  `MessageDeduplicationId` e do inbox de quem consome para que ela seja
  inofensiva. Um consumidor externo mal implementado sofre com isso — e nós
  não controlamos quem consome.
- Dois entrypoints significam dois processos a subir, e um `docker compose up`
  que esqueça o worker produz um sistema em que a API responde, as apostas são
  aceitas, e **nada** é consumido nem publicado. O perfil `app` do Compose
  sobe os dois juntos justamente por isso.
- O worker ocupa uma segunda porta. Em ambiente com portas escassas, é uma a
  mais para alocar.

**Neutras**

- O publicador mede o lag a cada passada. A consulta é `count` e `min` sobre o
  índice parcial de pendentes, barata — e um lag atualizado a cada cinco
  segundos não serviria de alarme.
- O intervalo de varredura do worker de referência é mais folgado que o do
  publicador (5 s contra 1 s) porque a menor espera da agenda da seção 7.1 é
  de onze minutos. Varrer de segundo em segundo só geraria consulta vazia.

## Alternativas consideradas

**Workers dentro do processo da API.** Descartada: competição por event loop e
pool de conexões, com sintomas que não apontam para a causa. Teria a vantagem
de um processo só para subir, e o perfil `app` do Compose resolve isso sem o
custo.

**Um processo por worker, três no total.** Descartada por ora. É o desenho
certo quando um deles precisar de escala própria, e hoje nenhum precisa. A
costura está no `WorkersModule`.

**Marcar o evento como publicado antes de publicar.** Descartada: troca a
janela de duplicação pela de perda, e o enunciado trata as duas de forma
assimétrica.

**Uma coluna de lease na outbox** (`claimed_by`, `claimed_until`), com claim e
publicação em transações separadas. Descartada: resolveria o lock mantido
durante a chamada de rede, ao custo de uma coluna, de um relógio
compartilhado e de um varredor de leases expirados. O `skip locked` entrega a
coordenação sem nenhum dos três.

**`@nestjs/schedule` com cron** em vez do laço próprio. Descartada: seria uma
dependência nova para um `while` com `sleep` interrompível, e o
comportamento que importa — não dormir quando há trabalho, acordar no
shutdown — não é o que um cron faz.

**Lote único para o worker de referência.** Descartada pelas razões de
isolamento e duração acima.

## Revisitar quando

- Um dos três trabalhos precisar de escala independente dos outros.
- O lock da wallet mantido durante o `SendMessage` do publicador aparecer como
  contenção medida. Aí a coluna de lease passa a pagar o seu custo.
- Entrar um segundo consumidor interno da fila de eventos. Hoje o
  `consumerName` do inbox já prevê isso, mas nunca foi exercitado com dois.
- O `VisibilityTimeout` de 30 s ficar perto do pior caso de processamento. Aí
  o consumidor precisa renovar a visibilidade enquanto trabalha.
