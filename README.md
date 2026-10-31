# Distributed Wagering Processor

**Serviço financeiro distribuído para processamento de transações de apostas**

Recebe operações de aposta de vários provedores de jogos, por HTTP e por
fila, e as processa mantendo saldo e ledger coerentes mesmo quando as
mensagens chegam duplicadas, fora de ordem ou ao mesmo tempo. As operações
são `BET`, `WIN`, `LOSS`, `REFUND` e `ROLLBACK`.

> **Status: os requisitos obrigatórios estão implementados, e a verificação
> rodou contra PostgreSQL e SQS de verdade.**
>
> Os sete endpoints respondem. O consumidor SQS deduplica por inbox no mesmo
> commit do efeito financeiro e só confirma a mensagem depois dele. O
> publicador da outbox trabalha com vários publicadores concorrentes, e o
> worker de referência reavalia o que chegou fora de ordem.
>
> **605 testes passam**, dos quais **172 conversam com PostgreSQL, MiniStack e
> processos reais** — entre eles os oito cenários de concorrência, que rodam
> com três instâncias da aplicação em processos separados.
>
> A evidência mais direta de que a corretude não é de processo: uma aposta
> aplicada numa réplica, com o replay da mesma `Idempotency-Key` enviado a uma
> **terceira**, devolveu o mesmo `transactionId` e `idempotentReplay: true`.
>
> Fora do escopo, por decisão registrada: autenticação e teste de carga.
>
> O que está pronto, em [Implementado](#implementado). As evidências, em
> [Validação](#validação). O que **não** foi verificado, na seção 11 do
> [ARCHITECTURE.md](ARCHITECTURE.md).

## Stack

| Área                                          | Tecnologia                                 | Estado                                                   |
| --------------------------------------------- | ------------------------------------------ | -------------------------------------------------------- |
| Runtime, gerenciador de pacotes e test runner | Bun 1.4                                    | em uso                                                   |
| Linguagem                                     | TypeScript 5.9, modo estrito               | em uso                                                   |
| Framework                                     | NestJS 12                                  | em uso                                                   |
| Persistência                                  | PostgreSQL 17.6 · MikroORM 7               | em uso, validado                                         |
| Mensageria                                    | AWS SQS via MiniStack 1.5.33               | em uso, validado                                         |
| SDK                                           | AWS SDK for JavaScript v3                  | em uso                                                   |
| Infraestrutura local                          | Docker Compose · Dockerfile                | em uso, validado                                         |
| Health checks                                 | `@nestjs/terminus`                         | em uso, validado                                         |
| Observabilidade                               | logs JSON · métricas em `/metrics`         | em uso, validado                                         |
| Qualidade estática                            | ESLint 10 com regras type-aware · Prettier | em uso                                                   |
| Identity Provider                             | —                                          | não implementado, ver [ARCHITECTURE.md](ARCHITECTURE.md) |

Nenhuma dependência de runtime foi acrescentada para observabilidade: o
registry de métricas e o logger JSON são próprios. A razão está no
[ADR-014](docs/adr/ADR-014-observabilidade-sem-dependencia-nova.md).

## Arquitetura

Clean Architecture em camadas, com as dependências apontando para dentro:

```
interfaces ──────► application ──────► domain
     │                                    ▲
     └──► infrastructure ─────────────────┘
```

A mesma aplicação assume **dois papéis**, escolhidos pelo entrypoint:

| Papel  | Entrypoint      | O que sobe                                           |
| ------ | --------------- | ---------------------------------------------------- |
| API    | `src/main.ts`   | 7 endpoints da §9 + `/health` + `/metrics`           |
| Worker | `src/worker.ts` | consumidor SQS, publicador da outbox, worker de ref. |

As quatro portas de entrada — HTTP, fila, publicador e worker de
referência — convergem para os **mesmos** casos de uso, como a seção 10 do
enunciado exige.

- [Visão geral da arquitetura](docs/architecture/overview.md) — estado atual,
  com diagrama de componentes
- [ARCHITECTURE.md](ARCHITECTURE.md) — decisões, trade-offs e limitações,
  como pede o enunciado

### ADRs

| ADR                                                                          | Decisão                                 |
| ---------------------------------------------------------------------------- | --------------------------------------- |
| [001](docs/adr/ADR-001-camadas-em-aplicacao-nestjs.md)                       | camadas dentro de uma aplicação NestJS  |
| [002](docs/adr/ADR-002-ministack-como-emulador-sqs.md)                       | MiniStack como emulador de SQS          |
| [003](docs/adr/ADR-003-mikroorm-e-migrations.md)                             | MikroORM e migrations versionadas       |
| [004](docs/adr/ADR-004-estrategia-de-confiabilidade.md)                      | estratégia de confiabilidade            |
| [005](docs/adr/ADR-005-money-como-bigint-de-centavos.md)                     | `Money` como `bigint` de centavos       |
| [006](docs/adr/ADR-006-garantias-no-schema.md)                               | garantias financeiras no schema         |
| [007](docs/adr/ADR-007-uma-moeda-por-linha.md)                               | uma moeda por linha                     |
| [008](docs/adr/ADR-008-mapeamento-de-persistencia.md)                        | modelos de persistência separados       |
| [009](docs/adr/ADR-009-prazos-explicitos-de-indisponibilidade.md)            | prazos explícitos de indisponibilidade  |
| [010](docs/adr/ADR-010-ordem-do-caso-de-uso-de-submissao.md)                 | a ordem do caso de uso de submissão     |
| [011](docs/adr/ADR-011-consumidor-sqs-e-inbox-transacional.md)               | consumidor SQS e inbox transacional     |
| [012](docs/adr/ADR-012-fila-de-saida-de-eventos.md)                          | fila de saída dos eventos               |
| [013](docs/adr/ADR-013-modelo-de-execucao-dos-workers.md)                    | modelo de execução dos workers          |
| [014](docs/adr/ADR-014-observabilidade-sem-dependencia-nova.md)              | observabilidade sem dependência nova    |
| [015](docs/adr/ADR-015-execucao-multi-instancia-e-testes-de-concorrencia.md) | execução multi-instância e concorrência |

## Estrutura do repositório

```
.
├── docker-compose.yml              PostgreSQL, MiniStack e o perfil `app`
├── Dockerfile                      imagem da aplicação, os dois papéis
├── mikro-orm.config.ts             entrada da CLI de migrations
├── docs/
│   ├── architecture/overview.md
│   └── adr/                        15 ADRs
├── scripts/
│   ├── bootstrap-queues.ts         cria as quatro filas
│   ├── check-infra.ts              diagnóstico de PostgreSQL e SQS
│   └── run-suite.ts                roda uma suíte, um arquivo por processo
├── src/
│   ├── main.ts                     entrypoint da API
│   ├── worker.ts                   entrypoint do trabalho de fundo
│   ├── app.module.ts               raiz de composição da API
│   ├── worker.module.ts            raiz de composição do worker
│   ├── config/                     contrato e validação do ambiente
│   ├── shared/                     utilidades sem dependência de camada
│   ├── domain/                     Money, Wallet, WagerTransaction, ledger,
│   │                               inbox, outbox, eventos
│   ├── application/
│   │   ├── contracts/              schemas de entrada (HTTP e fila)
│   │   ├── ports/                  as portas que a aplicação declara
│   │   └── use-cases/              nove casos de uso
│   ├── infrastructure/
│   │   ├── persistence/            MikroORM, migrations, repositórios
│   │   ├── messaging/              cliente SQS, topologia, consumidor,
│   │   │                           publicador de eventos
│   │   ├── observability/          logger JSON e registry de métricas
│   │   ├── system/                 relógio, ids, identidade
│   │   └── composition/            instanciação dos casos de uso
│   └── interfaces/
│       ├── http/                   controllers, health, /metrics
│       └── workers/                consumidor e os dois workers de polling
└── test/
    ├── unit/                       lógica pura, sem E/S
    ├── smoke/                      contrato de runtime
    ├── integration/                PostgreSQL e SQS reais
    └── concurrency/                processos reais, paralelismo real
```

## Como executar

**Pré-requisitos:** [Bun 1.x](https://bun.sh) e
[Docker](https://docs.docker.com/get-docker/) com Docker Compose. Confira com
`bun --version` e `docker compose version`.

### Caminho curto

Tudo de uma vez, do zero:

```bash
bun install && cp .env.example .env && bun run infra:up && bun run queues:bootstrap && bun run migration:up
```

Depois, a API e o worker em dois terminais:

```bash
bun run dev
```

```bash
bun run dev:worker
```

### Passo a passo

**1. Dependências e ambiente**

```bash
bun install
```

```bash
cp .env.example .env
```

Cada variável vem comentada no `.env.example`, e os valores padrão já
correspondem ao que o Compose sobe. Nenhum deles é segredo de verdade, e o
`.env` fica fora do versionamento.

**2. Infraestrutura**

```bash
bun run infra:up
```

Sobe o PostgreSQL em `localhost:5433` e o MiniStack em `localhost:4566`. A
porta 5433 é para não brigar com uma instalação nativa de PostgreSQL, que
costuma ocupar a 5432.

**3. Filas**

```bash
bun run queues:bootstrap
```

Cria **quatro** filas: a de entrada e a sua DLQ, e a de saída dos eventos de
integração e a sua DLQ. A fila de saída não vem do enunciado — ver
[ADR-012](docs/adr/ADR-012-fila-de-saida-de-eventos.md). O script é
idempotente.

> O MiniStack não tem volume: se o contêiner for recriado, as filas vão
> embora e este comando precisa rodar de novo. O `bun run infra:check` acusa.

**4. Migrations**

```bash
bun run migration:up
```

Para reverter a última:

```bash
bun run migration:down
```

**5. Aplicação**

A API, em `http://localhost:3000`:

```bash
bun run dev
```

E o processo de trabalho de fundo — consumidor da fila, publicador da outbox e
worker de referência pendente — em `http://localhost:3001`, que serve só
`/health` e `/metrics`:

```bash
bun run dev:worker
```

**Os dois são necessários.** Só com a API, as apostas por HTTP funcionam, mas
nada consome a fila e os eventos ficam parados na outbox.

**6. Conferir**

```bash
bun run infra:check
```

Checa PostgreSQL e as duas filas principais por fora da aplicação, e sai com
código diferente de zero se algo não responder. É o primeiro comando a rodar
quando algo quebra localmente, porque separa "a aplicação está com problema"
de "a infraestrutura não subiu".

```bash
curl http://localhost:3000/health/ready
```

```bash
curl http://localhost:3000/metrics
```

### Três instâncias, como a seção 8 exige

```bash
docker compose --profile app up -d --build --scale api=3
```

Sobe a imagem da aplicação, aplica as migrations, cria as filas e deixa de pé
**três réplicas da API** (em 3000, 3001 e 3002) mais o worker (em 3100). O
perfil `app` existe para que `bun run infra:up` continue subindo só a
infraestrutura.

```bash
docker compose --profile app ps
```

Para derrubar só a aplicação, mantendo PostgreSQL e MiniStack:

```bash
docker compose --profile app rm -sf api worker bootstrap
```

> `docker compose --profile app down` derruba **também** a infraestrutura. O
> volume do PostgreSQL é nomeado e sobrevive, mas as filas do MiniStack não.

### Encerrar

```bash
bun run infra:down
```

Para apagar também o volume do PostgreSQL, use `bun run infra:reset`. **É
destrutivo** — os dados locais vão junto.

## Comandos

| Comando                                   | O que faz                                      |
| ----------------------------------------- | ---------------------------------------------- |
| `bun run dev`                             | API em modo watch                              |
| `bun run dev:worker`                      | worker em modo watch                           |
| `bun run start` / `start:worker`          | API e worker sem watch                         |
| `bun run check`                           | typecheck, lint e verificação de formatação    |
| `bun run typecheck`                       | `tsc --noEmit` em modo estrito                 |
| `bun run lint`                            | ESLint com regras que usam informação de tipos |
| `bun run format`                          | Prettier, escrevendo                           |
| `bun test`                                | testes de unidade e de smoke                   |
| `bun run test:integration`                | contra PostgreSQL e SQS reais                  |
| `bun run test:concurrency`                | com processos e paralelismo reais              |
| `bun run test:all`                        | os três escopos em sequência                   |
| `bun run infra:up` / `infra:down`         | sobe e derruba a infraestrutura                |
| `bun run infra:reset`                     | derruba **e apaga o volume**                   |
| `bun run infra:check`                     | diagnóstico de conectividade                   |
| `bun run queues:bootstrap`                | cria as quatro filas                           |
| `bun run migration:create`                | gera uma migration                             |
| `bun run migration:up` / `migration:down` | aplica e reverte                               |
| `bun run migration:list`                  | lista o que já foi aplicado                    |

## Variáveis de ambiente

O contrato completo, comentado, está em [`.env.example`](.env.example). Em
resumo:

| Variável                                              | Propósito                                             |
| ----------------------------------------------------- | ----------------------------------------------------- |
| `NODE_ENV`                                            | `development`, `test` ou `production`                 |
| `APP_PORT` · `WORKER_PORT`                            | portas HTTP da API e do worker                        |
| `LOG_LEVEL`                                           | verbosidade dos logs JSON                             |
| `POSTGRES_HOST` · `POSTGRES_PORT`                     | endereço do banco; `5433` no host                     |
| `POSTGRES_USER` · `POSTGRES_PASSWORD` · `POSTGRES_DB` | credenciais e banco                                   |
| `AWS_REGION`                                          | exigida pelo SDK mesmo contra emulador                |
| `AWS_ACCESS_KEY_ID` · `AWS_SECRET_ACCESS_KEY`         | credenciais fictícias locais                          |
| `SQS_ENDPOINT`                                        | endpoint do emulador; vazio significa AWS real        |
| `SQS_QUEUE_NAME` · `SQS_DLQ_NAME`                     | fila de entrada e DLQ; sufixo `.fifo` validado        |
| `SQS_EVENTS_QUEUE_NAME` · `SQS_EVENTS_DLQ_NAME`       | fila de saída dos eventos e DLQ                       |
| `SQS_CONSUMER_NAME`                                   | chave do inbox, junto ao `messageId`                  |
| `SQS_REQUEST_TIMEOUT_MS`                              | prazo da requisição; piso validado contra o long poll |
| `SQS_CONNECTION_TIMEOUT_MS`                           | prazo só para abrir a conexão                         |
| `CONSUMER_MAX_MESSAGES`                               | mensagens por `ReceiveMessage`; teto 10               |
| `WORKER_SHUTDOWN_TIMEOUT_MS`                          | prazo do encerramento gracioso                        |
| `OUTBOX_POLL_INTERVAL_MS` · `OUTBOX_BATCH_SIZE`       | ritmo e lote do publicador                            |
| `REFERENCE_POLL_INTERVAL_MS` · `REFERENCE_BATCH_SIZE` | ritmo e lote do worker de referência                  |
| `HEALTH_CHECK_TIMEOUT_MS`                             | prazo de cada verificação do `/health/ready`          |

A validação acontece uma única vez, na inicialização, e reclama de todas as
variáveis inválidas de uma vez. Com o ambiente incompleto o processo nem chega
a subir — bem melhor do que descobrir o problema numa falha obscura de
conexão lá na frente.

## Testes

| Escopo          | Diretório                 | Dependências                | Resultado |
| --------------- | ------------------------- | --------------------------- | --------- |
| Unidade e smoke | `test/unit`, `test/smoke` | nenhuma                     | 433 ✓     |
| Integração      | `test/integration`        | PostgreSQL e MiniStack      | 161 ✓     |
| Concorrência    | `test/concurrency`        | ambos, mais processos reais | 11 ✓      |

Total: **605 testes, 0 falhas.** Dos 605, **172 conversam com serviços
reais** — e 11 deles com três instâncias da aplicação em processos separados.

```bash
bun run test:all
```

As suítes de integração e de concorrência rodam **um arquivo por processo**,
pelo `scripts/run-suite.ts`. A razão é mecânica e vale registrar: cada suíte
aponta para o seu banco e as suas filas ajustando `process.env` antes de
importar `ConfigModule`, e o `NestConfigModule.forRoot` é avaliado no import,
que o processo cacheia. Num processo compartilhado, o segundo arquivo recebia o
`ConfigModule` do primeiro, e os seus workers operavam no banco errado — cada
arquivo passava sozinho e a suíte inteira falhava por timeout.

### Nenhum teste troca PostgreSQL ou SQS por dublê

Dois arquivos usam dublês, e os declaram no topo:

- `test/unit/health-timeout.spec.ts` — provar que o `/health/ready` responde
  quando a dependência **não** responde exige uma dependência que trave sob
  demanda, e isso não se pede a um serviço real de forma determinística;
- `test/unit/sqs-consumer.spec.ts` — o que ele verifica é a **ordem** dos
  comandos que o consumidor emite ao broker (`ack` depois do commit, DLQ antes
  da confirmação, grupos em paralelo), e provar ordem contra um serviço real
  exigiria travá-lo sob demanda.

Os testes de integração rodam contra o PostgreSQL e o MiniStack que o Compose
sobe. O de PostgreSQL cria um banco só dele, terminado em `_test`, com uma
trava que recusa qualquer nome fora desse padrão. Os de SQS criam filas
descartáveis com nome único e apagam tudo no final.

### Os oito cenários de concorrência da seção 13

| Cenário                              | Onde                             |
| ------------------------------------ | -------------------------------- |
| 1 — mesma aposta 50× em paralelo     | `concurrency/hot-wallet.spec.ts` |
| 2 — disputa pelo saldo (seção 8)     | `concurrency/hot-wallet.spec.ts` |
| 3 — wallets distintas em paralelo    | `concurrency/hot-wallet.spec.ts` |
| 4 — três instâncias simultâneas      | `concurrency/hot-wallet.spec.ts` |
| 5 — worker morto entre commit e ack  | `concurrency/recovery.spec.ts`   |
| 6 — dois publicadores sobre a outbox | `concurrency/recovery.spec.ts`   |
| 7 — reversão antes da referência     | `concurrency/recovery.spec.ts`   |
| 8 — reinício com consistência final  | `concurrency/recovery.spec.ts`   |

Todo cenário que move saldo termina com a invariante final da seção 13,
conferida em SQL cru por fora do domínio:

```
wallet.balance == saldo reconstruído pelo ledger
```

Nenhum deles afirma **qual** tentativa vence — só o estado final, que é o que
o enunciado exige e o único que é determinístico. Ver
[ADR-015](docs/adr/ADR-015-execucao-multi-instancia-e-testes-de-concorrencia.md).

## Implementado

**Domínio e persistência**

- Domínio financeiro puro, sem nenhum import de ORM ou framework: `Money` em
  `bigint` de centavos, `Wallet` como aggregate root, `WagerTransaction` com
  ciclo de vida, ledger imutável, inbox, outbox e envelope de evento
- Schema financeiro completo em uma migration, com as garantias da restrição 9
  **no banco**: 37 constraints nas cinco tabelas financeiras (23 `check`,
  5 `unique`, 4 foreign keys e 5 chaves primárias), 3 triggers de append-only
  no ledger e 4 índices parciais — entre eles o que impede a mesma referência
  de ser revertida duas vezes pelo mesmo tipo
- Repositórios sobre `EntitySchema` com modelos de persistência separados e
  mappers, lock pessimista por wallet, `for update skip locked` na outbox, e
  fronteira transacional em que os repositórios só existem dentro dela

**API HTTP**

- Os sete endpoints da seção 9: criação de wallet com `OPENING` e lançamento
  no mesmo commit, submissão de transação com idempotência por constraint e
  lock pessimista por wallet, as duas consultas de transação, extrato com
  cursor keyset opaco, e reconciliação que detecta divergência sem corrigi-la
- Mapeamento de falha para HTTP num `Record` total: payload inválido (400),
  conflito de idempotência (409), recusa de negócio (422), aceite pendente
  (202) e indisponibilidade (503) — as cinco situações que a seção 9 manda
  distinguir
- `ProviderIdentityPort` como ponto de extensão de autenticação, chamado pelo
  caso de uso e com implementação no-op, conforme a seção 2

**Mensageria**

- **Consumidor SQS** reaproveitando o mesmo caso de uso do HTTP, com
  deduplicação por inbox `(consumerName, messageId)` no **mesmo commit** do
  efeito financeiro, `ack` somente depois do commit, classificação de erro em
  três classes (negócio, transitório, permanente), envio explícito à DLQ no
  erro permanente, grupos em paralelo com ordem preservada dentro do grupo, e
  encerramento gracioso que cancela o long poll e devolve a visibilidade
- **Publicador da outbox** com vários publicadores concorrentes coordenados
  por `for update skip locked`, backoff exponencial com teto, e
  `MessageGroupId` igual à `walletId` com `MessageDeduplicationId` igual ao
  `eventId`
- **Worker de referência pendente** executando a agenda de 8 tentativas em 24
  horas, uma transação SQL por transação de negócio, com recusa
  `REFERENCE_NOT_FOUND` e evento publicado ao esgotar
- Topologia das quatro filas declarada num lugar só, e script idempotente que
  as cria

**Observabilidade**

- Logs estruturados em JSON, uma linha por registro, com os cinco campos de
  correlação da seção 12 no topo do objeto; o tipo do contexto só aceita
  escalares, o que torna impossível passar payload financeiro por engano
- Onze métricas em `GET /metrics`, em texto Prometheus, sem dependência de
  runtime, todas emitidas em zero antes da primeira observação
- `GET /health/live` e `GET /health/ready` separados, nos **dois** processos,
  com prazo próprio por verificação

**Infraestrutura e qualidade**

- `docker-compose.yml` com PostgreSQL 17.6 e MiniStack 1.5.33, mais o perfil
  `app` que sobe a aplicação com réplicas escaláveis
- `Dockerfile` multi-stage com versão fixada, um papel por comando
- Contrato de ambiente em zod, validado na inicialização, único ponto do
  sistema que lê `process.env`
- ESLint com regras que usam informação de tipos, Prettier e typecheck — os
  três passando

## Validação

Executada em 2026-10-30, no Windows 10 com Docker 29.7.2 sobre WSL 2.

| Verificação                                     | Resultado                            |
| ----------------------------------------------- | ------------------------------------ |
| `bun run check`                                 | exit 0 — typecheck, lint, formatação |
| `bun run test`                                  | 433 passando, 0 falhando             |
| `bun run test:integration`                      | 161 passando em 10 arquivos          |
| `bun run test:concurrency`                      | 11 passando em 2 arquivos            |
| `bun run infra:up`                              | ambos os containers `healthy`        |
| `bun run queues:bootstrap`                      | quatro filas; idempotente            |
| `bun run infra:check`                           | PG 17.6; as duas filas FIFO com DLQ  |
| `migration:create` → `up` → `list` → `down`     | aplicada e revertida                 |
| `docker compose --profile app up --scale api=3` | 3 réplicas + worker, todas `healthy` |
| `GET /health/ready` com a infraestrutura no ar  | `200`, `postgres: up`, `sqs: up`     |
| `GET /health/ready` com a infraestrutura fora   | `503`, `ECONNREFUSED` identificado   |
| `GET /health/ready` com o SQS calado            | `503` em 2,02 s                      |

### Ponta a ponta, em contêiner, com três réplicas

Com três réplicas da API em 3000, 3001 e 3002, e o worker em 3100:

1. wallet criada na réplica **:3000** → saldo `1000.00`, `version` 1
2. `BET` de `25.00` na réplica **:3001** → `PROCESSED`, saldo `975.00`
3. a **mesma** `Idempotency-Key` reenviada na réplica **:3002** → mesmo
   `transactionId`, mesmo saldo, `idempotentReplay: true`
4. reconciliação em **:3000** → `consistent: true`, `difference: 0.00`,
   `checkedEntries: 2`
5. mensagem publicada em `wager-transactions.fifo` → consumida pelo worker em
   **~1 s**, saldo `875.00`, eventos publicados na fila de saída

O passo 3 é a evidência mais direta de que a idempotência é **persistente e
atravessa instâncias**: a réplica que respondeu o replay não é a que gravou a
transação, e nenhuma delas compartilha memória com a outra.

### Para reproduzir do zero

```bash
bun install && cp .env.example .env && bun run infra:up && bun run queues:bootstrap && bun run infra:check && bun run migration:up && bun run test:all
```

### O que ficou sem verificação

As limitações estão listadas em [ARCHITECTURE.md](ARCHITECTURE.md) §11, em
ordem de quanto pesam. As duas primeiras:

- **A equivalência entre MiniStack e o SQS da AWS nas bordas.** As quatro
  capacidades que o desenho usa passaram contra o emulador real, mas a janela
  de deduplicação de cinco minutos e a ordenação estrita por grupo sob
  contenção não foram exercitadas.
- **Carga.** Os testes de concorrência provam corretude com paralelismo real,
  não desempenho. Não há throughput, latência percentil nem outbox lag sob
  pressão — o `test:load` é diferencial opcional no enunciado e ficou fora do
  escopo.

## Decisões arquiteturais

As decisões e seus trade-offs estão em [ARCHITECTURE.md](ARCHITECTURE.md),
como pede o enunciado, e detalhadas nos ADRs. As que mais moldaram o
resultado:

**Lock pessimista por wallet, não otimista com retry.** O cenário obrigatório
da seção 8 é uma hot wallet, e com contenção de verdade o otimista vira uma
cascata de retries justamente quando o sistema está sob carga. O lock é por
linha, nunca global, perguntar "tem saldo?" e debitar acontecem dentro dele.
Ver [ARCHITECTURE.md](ARCHITECTURE.md) §4.

**Idempotência por constraint, não por verificação.** Inserir direto e tratar
a violação de unicidade como fluxo normal. Consultar antes de inserir é
`read → calculate → update` com outro nome, e duas instâncias o atravessam
juntas sem perceber. Ver
[ADR-010](docs/adr/ADR-010-ordem-do-caso-de-uso-de-submissao.md).

**São duas guardas de duplicidade, não uma.** A `idempotency_key` protege
contra a mesma **operação** submetida duas vezes; o inbox, contra a mesma
**mensagem** entregue duas vezes. Uma não cobre o caso da outra.

**O caso de uso de submissão foi dividido para que o consumidor o reusasse.**
`prepare` fora da transação, `executeWithin` dentro dela, e a fronteira
transacional pertence a quem chama — é o que permite ao consumidor gravar o
inbox no mesmo commit do efeito sem duplicar regra nenhuma. Ver
[ADR-011](docs/adr/ADR-011-consumidor-sqs-e-inbox-transacional.md).

**Publicar e só então marcar.** Isso admite republicação depois de uma queda, e
é deliberado: a alternativa fecharia a janela de duplicação e abriria a de
perda, e o enunciado trata as duas de forma assimétrica. Ver
[ADR-013](docs/adr/ADR-013-modelo-de-execucao-dos-workers.md).

**Fila de saída própria para os eventos.** O enunciado nomeia só as de
entrada; publicar evento nelas faria o consumidor receber de volta o que ele
mesmo causou. Ver [ADR-012](docs/adr/ADR-012-fila-de-saida-de-eventos.md).

**Observabilidade sem dependência nova.** Contador, gauge e histograma em
~250 linhas com teste, contra uma dependência de runtime que o enunciado não
exige. Decisão de fronteira, e o ADR registra quando revisitá-la. Ver
[ADR-014](docs/adr/ADR-014-observabilidade-sem-dependencia-nova.md).

**MiniStack em vez de LocalStack.** A edição Community do LocalStack foi
descontinuada em março de 2026; a imagem atual exige token e o plano gratuito
proíbe uso comercial. Num projeto que alguém precisa levantar com um comando
para avaliar, exigir cadastro atrapalha sem compensar. O MiniStack é MIT, roda
sem conta e atende no mesmo endpoint `:4566` — por isso a escolha não aparece
em lugar nenhum do código. Ver
[ADR-002](docs/adr/ADR-002-ministack-como-emulador-sqs.md).

**MikroORM em vez de TypeORM.** É o preferido do enunciado e traz as
primitivas de que a estratégia depende: `EntityManager.transactional()` com
savepoints aninhados, e `LockMode` com `PESSIMISTIC_WRITE` e
`PESSIMISTIC_PARTIAL_WRITE`. Ver
[ADR-003](docs/adr/ADR-003-mikroorm-e-migrations.md).

**A aplicação sobe mesmo com as dependências fora do ar.** Em vez de morrer na
inicialização, o processo sobe e reporta readiness como indisponível. Assim um
orquestrador diferencia um processo quebrado de uma dependência fora do ar.

**Sem autenticação, por escolha registrada.** A seção 2 do enunciado permite, e
diz que autenticação não vale pontos. O ponto de extensão existe, é chamado e
tem teste. Ver [ARCHITECTURE.md](ARCHITECTURE.md) §8.
