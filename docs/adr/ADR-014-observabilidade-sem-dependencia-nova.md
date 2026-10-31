# ADR-014 — Observabilidade sem dependência nova

- **Status:** Aceito e implementado
- **Data:** 2026-10-30
- **Decidido por:** Patrick Oliveira

## Contexto

A seção 12 do enunciado é específica sobre o que exige:

- **logs estruturados (JSON)** com `correlationId`, `messageId`,
  `transactionId`, `walletId`, `providerId`;
- **sem** dados sensíveis ou payloads financeiros completos nos logs;
- **métricas** cobrindo, no mínimo: transações por status, duplicatas
  detectadas, retries, mensagens em DLQ, conflitos de lock, outbox lag e
  latência de processamento;
- **health checks** separados para liveness e readiness.

OpenTelemetry e dashboard são declarados opcionais.

A seção 9 acrescenta uma nona métrica que é fácil de perder de vista:
divergência de reconciliação precisa ser "logada, **contabilizada em
métrica** e sinalizada na resposta".

O que existia antes desta decisão: os dois health checks, e um `LoggerPort`
com implementação mínima sobre o `Logger` do Nest, que formatava
`chave=valor`. Nenhuma métrica. Nenhuma biblioteca de observabilidade
instalada.

## Decisão

Implementar os dois — logs JSON e métricas — **sem acrescentar dependência de
runtime**.

### Logs: uma linha JSON, escrita direto em `stdout`

`JsonLogger` substitui o adapter sobre o `Logger` do Nest. Um registro por
linha, com `level`, `time`, `msg` e os campos de contexto **no topo** do
objeto, não aninhados.

Escreve direto em `process.stdout`, sem passar pelo logger do Nest. Não é
preferência: o logger do Nest prefixa cada linha com carimbo de tempo, nome de
contexto e códigos de cor ANSI, e qualquer um dos três quebra o parsing da
linha como JSON — que é o único motivo de o formato ser JSON.

Os campos ficam no topo para que um coletor consulte por `correlationId` sem
precisar conhecer a forma do nosso envelope. Campo indefinido é **omitido** em
vez de virar `null`: um `null` obriga quem consulta a tratar dois valores para
"não informado". E um contexto que traga `level`, `time` ou `msg` recebe
prefixo `_`, de modo que não sobrescreva o envelope e o registro não minta
sobre a própria severidade.

**A proibição de payload financeiro já estava garantida pelo tipo.** O
`LogContext` só aceita `string | number | boolean | undefined`, então não há
como passar um objeto de domínio por engano. Esta decisão não acrescenta
proteção; ela se apoia na que já existia.

### Métricas: registry próprio, exposto em texto Prometheus

Um `MetricsPort` com `increment`, `gauge` e `observe`, e um
`InMemoryMetricsRegistry` que serializa no formato de texto do Prometheus,
servido em `GET /metrics` — aberto, como os health checks.

**Por que caseiro e não `prom-client`.** O domínio precisa de três
primitivas: contador, gauge e histograma de latência. O formato de texto do
Prometheus é estável e curto o bastante para que a implementação caiba em
~250 linhas com teste. Instalar uma biblioteca de runtime para isso vai contra
a política declarada do projeto de não acrescentar dependência que não é
usada de verdade — a mesma razão pela qual nenhuma biblioteca decimal foi
instalada (ver [ADR-005](ADR-005-money-como-bigint-de-centavos.md)).

### O catálogo declara as métricas antes do primeiro uso

Todas as séries são declaradas em um lugar só, com tipo e rótulos permitidos,
e o registry as emite **em zero** antes da primeira observação.

Isso não é organização: é o que distingue "não aconteceu" de "não está
instrumentado". Série que só nasce quando o evento acontece faz o gráfico
pular de "sem dados" para um valor, e quem olha não sabe qual dos dois casos
está vendo — exatamente a dúvida que a métrica existe para resolver.

| Métrica                                | Tipo      | Rótulos                    |
| -------------------------------------- | --------- | -------------------------- |
| `wagering_transactions_total`          | counter   | `kind`, `status`, `source` |
| `wagering_duplicates_detected_total`   | counter   | `guard`                    |
| `wagering_retries_total`               | counter   | `subject`                  |
| `wagering_dlq_messages_total`          | counter   | `reason`                   |
| `wagering_lock_conflicts_total`        | counter   | `subject`                  |
| `wagering_outbox_pending_age_seconds`  | gauge     | —                          |
| `wagering_outbox_pending_count`        | gauge     | —                          |
| `wagering_outbox_published_total`      | counter   | `outcome`                  |
| `wagering_processing_duration_seconds` | histogram | `operation`, `outcome`     |
| `wagering_reconciliation_checks_total` | counter   | `result`                   |
| `wagering_messages_received_total`     | counter   | `outcome`                  |

**Rótulo fora do catálogo lança.** As duas alternativas são piores: gravar
cria série paralela que ninguém soma, e ignorar produz um painel que parece
certo e está errado. Como é erro de programação, aparece na primeira execução
do teste que cobre o caminho.

O rótulo `source` — `http`, `sqs`, `worker` — existe porque a seção 10 manda o
consumidor reusar o mesmo caso de uso do HTTP. Sem ele, as duas entradas
viram uma série só e não há como ver que a fila parou de entregar.

### A métrica é registrada no ponto de entrada, depois do commit

Duas regras, e as duas têm consequência:

**Depois do commit.** Dentro da transação, um desfecho que depois revertesse
já teria sido contado, e a métrica passaria a divergir do banco justamente no
cenário em que alguém vai olhá-la.

**No ponto de entrada.** O controller HTTP, o consumidor e o worker registram
cada um com o seu `source`. Registrar dentro do caso de uso compartilhado
daria o mesmo rótulo às três entradas.

### O registry é por processo, e isso é correto

Cada instância expõe o seu próprio `/metrics`. Agregar é trabalho do coletor,
que é quem sabe quantas instâncias existem. O que precisa ser global não mora
no processo: o **outbox lag** é lido do banco a cada passada do worker, e por
isso é gauge e não contador.

Efeito colateral útil: o `/metrics` de cada processo serve de prova de que
aquele processo trabalhou, e os testes de concorrência usam isso para
demonstrar paralelismo real.

## Verificação

- `test/unit/metrics-registry.spec.ts` (21 casos) — contagem, rótulo, ordem
  de rótulos, bucket cumulativo, valor exatamente no limite, `+Inf`, escape de
  aspas e barras, ausência de notação científica, toda métrica do catálogo em
  zero antes do primeiro uso, e as exceções de rótulo e de tipo errados.
- `test/unit/json-logger.spec.ts` (13 casos) — envelope, os cinco campos de
  correlação da seção 12 no topo, omissão de indefinido, contexto que não
  sobrescreve o envelope, filtro por nível, e a garantia de que um registro
  nunca vira dois por causa de quebra de linha.
- `test/integration/api.spec.ts` — `GET /metrics` responde 200 em texto
  Prometheus com `no-store`, declara `HELP` e `TYPE` de toda métrica do
  catálogo, e **`METRICS` e `METRICS_EXPOSITION` são o mesmo objeto** (com
  duas instâncias, o endpoint responderia zero para sempre e o bug não daria
  sinal nenhum).
- `test/concurrency/hot-wallet.spec.ts` e `recovery.spec.ts` — as métricas de
  cada processo são lidas por HTTP para provar que as três instâncias
  atenderam requisições e que os dois publicadores publicaram.

Em container, com três réplicas no ar, o `/metrics` do worker respondeu com as
séries em zero antes do primeiro tráfego, como o catálogo prevê.

## Consequências

**Positivas**

- Nenhuma dependência de runtime acrescentada.
- Toda série declarada aparece em zero desde a primeira raspagem.
- Rótulo errado é erro de compilação de teste, não painel silenciosamente
  errado.
- A proibição de payload financeiro no log é garantida pelo **tipo**, não por
  revisão.
- O `/metrics` por processo virou ferramenta de teste de concorrência.

**Negativas**

- **A implementação do formato é nossa.** O formato de texto do Prometheus tem
  detalhes — `le` cumulativo, `+Inf`, escape, ausência de notação
  científica — e cada um deles é um teste nosso em vez de um problema
  resolvido por uma biblioteca madura. Se o formato evoluir, é nosso trabalho.
- Não há `_created`, nem exemplars, nem OpenMetrics. Um coletor que exija
  qualquer um desses não é atendido.
- Métrica por processo exige coletor que faça service discovery. Quem
  raspasse um endereço fixo com três réplicas atrás de um balanceador veria
  um terço dos números, de forma intermitente.
- O catálogo centralizado significa que acrescentar métrica é editar um array
  compartilhado — um ponto de conflito de merge que uma biblioteca com
  registro distribuído não teria.
- **Lançar em rótulo errado põe uma exceção de métrica no caminho de uma
  operação financeira.** A mitigação é que todo ponto de instrumentação é
  coberto por teste, e que o catálogo é tipado; mas a escolha prioriza
  descobrir o erro cedo sobre nunca falhar por causa de telemetria.

**Neutras**

- Os buckets de latência vão de 1 ms a 10 s em escala logarítmica. O piso é 1
  ms porque uma duplicata detectada pelo inbox termina sem tocar o domínio e
  precisa ser distinguível de zero; acima de 10 s o que importa saber é só que
  passou do aceitável, e para isso basta o `+Inf`.
- O `LoggerPort` continua com três níveis (`info`, `warn`, `error`). O
  `LOG_LEVEL` admite seis, e os outros três filtram sem nada emitir.
- O endpoint responde com `Cache-Control: no-store`. Cache de métrica é
  métrica errada.

## Alternativas consideradas

**`prom-client`.** Descartada. Resolveria o formato por nós e traria
`_created`, exemplars e coletores de métricas de processo de graça. O custo é
uma dependência de runtime que o enunciado não exige, num projeto que recusou
outras pela mesma razão. Decisão de fronteira; se o formato precisar evoluir,
é a primeira a revisitar.

**OpenTelemetry com exporter OTLP.** Descartada: o enunciado a declara
opcional, e ela traz um SDK grande mais um coletor no `docker-compose.yml`
para atender um requisito que o texto já considera satisfeito por métricas
simples.

**Contagem só em log estruturado, sem endpoint.** Descartada. É mais barato e
atende a parte de logs, mas a seção 12 pede **métrica**, e log não é métrica:
não se soma, não se agrega por janela, e um painel construído sobre contagem
de linhas de log depende do coletor acertar o parsing.

**Manter o `Logger` do Nest e só mudar o formatador.** Descartada: o prefixo e
as cores ANSI do logger do Nest quebram a linha como JSON. Haveria como
desligar os dois, ao custo de depender de detalhes de configuração do
framework para uma garantia de formato.

**Registrar métrica dentro do caso de uso compartilhado.** Descartada: as três
entradas receberiam o mesmo `source`, e a métrica deixaria de distinguir uma
fila parada de um provedor calado.

## Revisitar quando

- Um coletor exigir OpenMetrics, exemplars ou `_created`. Aí `prom-client`
  passa a pagar o seu custo.
- Tracing distribuído entrar no escopo. O `correlationId` já atravessa o
  sistema e seria o ponto de partida, mas propagação de contexto é trabalho de
  um SDK, não nosso.
- A cardinalidade de algum rótulo crescer. `reason` da DLQ e `failure_code`
  são hoje conjuntos fechados; se algum passar a carregar valor vindo do
  provedor, a série explode.
- O número de instâncias passar a variar sem service discovery no coletor.
  Nesse ponto um agregador no meio — um pushgateway, ou um sidecar — deixa de
  ser evitável.
