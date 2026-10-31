# Arquitetura — decisões, trade-offs e limitações

Por que o sistema é como é: o que foi decidido, o que ficou pelo caminho, e o
que cada escolha custou.

Três justificativas que o enunciado pede por escrito, e estão aqui: a escolha do
ORM com o mapeamento de `Money` e a estratégia transacional, na seção 3; a
estratégia de concorrência, na seção 4; a decisão sobre autenticação, na
seção 8.

Cada seção abre com um **rótulo de estado**. Todas dizem _Decidido e
implementado_ — o código existe, roda e tem teste contra PostgreSQL e SQS
reais —, menos a seção 8, que registra autenticação como _Decidido: não
implementar_.

Os rótulos não são decoração. Durante a construção, várias seções passaram por
_decidido, não implementado_ e por _a fronteira implementada, o caso de uso
não_, e era o rótulo que impedia este documento de prometer o que o código
ainda não fazia. **Nada aqui é descrito como pronto antes de estar.**

O estado peça por peça fica em
[docs/architecture/overview.md](docs/architecture/overview.md); cada decisão em
detalhe, com as alternativas que perderam, nos [ADRs](docs/adr). As limitações
do que **está** pronto estão na seção 11.

## 1. Escopo

**Os requisitos obrigatórios do enunciado estão implementados e exercitados
contra a infraestrutura de verdade.** Em ordem de peso na avaliação:

| Área do enunciado       | Estado                                                         |
| ----------------------- | -------------------------------------------------------------- |
| Correção financeira     | `Money` em `bigint`, ledger imutável, reversões, reconciliação |
| Concorrência            | lock pessimista por wallet, provado com 3 instâncias reais     |
| Idempotência            | constraint no schema, replay cruzando instâncias               |
| Mensageria e falhas     | inbox, outbox, retry, DLQ, crash recovery, `SIGTERM`           |
| Modelagem e arquitetura | invariantes encapsuladas, portas, quatro camadas               |
| Testes                  | 605 passando, dos quais 172 contra serviços reais              |
| Observabilidade         | logs JSON com correlação, 11 métricas, health separados        |
| Documentação            | este arquivo, o overview e 15 ADRs                             |

Duas coisas ficaram **deliberadamente de fora**, e as duas o enunciado
permite: autenticação (seção 8 deste documento) e teste de carga, que a seção
14 do enunciado trata como diferencial opcional.

A ordem de construção foi deliberada e vale registrar, porque explica por que
o schema é tão central nos ADRs: domínio, schema e repositórios vieram
**antes** dos casos de uso, porque as garantias da restrição 9 moram em
constraints, e constraint é o que mais custa mudar depois. Os casos de uso
chegaram em cima de peças já provadas contra o banco real; o consumidor e os
workers, em cima de casos de uso já provados.

## 2. Estrutura — camadas dentro de uma aplicação

**Decidido e implementado.**

Clean Architecture em quatro camadas (`domain`, `application`,
`infrastructure`, `interfaces`), tudo dentro de **uma** aplicação NestJS. Ela
assume papéis diferentes — API, consumidor SQS, worker de outbox — conforme o
entrypoint usado, sempre sobre a mesma raiz de composição.

O enunciado exige corretude com **três ou mais instâncias**. Essa exigência
fala do estado compartilhado, não de quantos artefatos existem: a corretude
precisa vir do PostgreSQL, e várias cópias do mesmo processo cobram isso tanto
quanto vários serviços separados — só que dão bem menos trabalho para subir na
máquina de quem avalia.

São **dois entrypoints**, e portanto dois processos: `src/main.ts` para a API e
`src/worker.ts` para o trabalho de fundo. A separação em processos existe por
uma razão concreta: um processo que atende requisições de negócio _e_ publica
eventos tem os dois competindo pelo mesmo event loop e pelo mesmo pool de
conexões, e uma rajada de apostas atrasaria a publicação de eventos sem que o
sintoma apontasse para a causa.

**Trade-off:** os **três trabalhos de fundo** — consumidor, publicador da
outbox e worker de referência — compartilham um processo, então escalam juntos
e caem juntos. Separá-los seria a decisão certa se cada um precisasse de
escala própria, e hoje nenhum precisa: os três são limitados pelo mesmo
PostgreSQL. A costura para separá-los é o `WorkersModule` — tirar um provider
de lá e dar-lhe um entrypoint é o trabalho inteiro.

**O outro custo é operacional:** dois processos a subir, e um ambiente que
esqueça o worker produz um sistema em que a API responde, as apostas são
aceitas, e nada é consumido nem publicado. O perfil `app` do Compose sobe os
dois juntos justamente por isso, e o README avisa.

Ver [ADR-001](docs/adr/ADR-001-camadas-em-aplicacao-nestjs.md) e
[ADR-013](docs/adr/ADR-013-modelo-de-execucao-dos-workers.md).

## 3. ORM, mapeamento de `Money` e estratégia transacional

### 3.1 ORM — MikroORM

**Decidido e implementado** — conexão, schema, mapeamento e repositórios.

MikroORM 7, o preferido do enunciado. Mas não foi a preferência que pesou, e
sim as primitivas de que a estratégia do [ADR-004](docs/adr/ADR-004-estrategia-de-confiabilidade.md)
depende:

- **`EntityManager.transactional()`** — a fronteira da transação fica
  explícita no código, em vez de implícita por convenção. Aninhado, emite
  `savepoint`, e é disso que depende a idempotência por constraint: no
  PostgreSQL, uma violação aborta a transação inteira, e a tentativa de
  inserção precisa ficar isolada para que o caminho de replay possa seguir
  lendo.
- **`LockMode`** — locking pessimista de primeira classe, exatamente o
  vocabulário que a seção 8 usa. `PESSIMISTIC_WRITE` para o lock por wallet,
  `PESSIMISTIC_PARTIAL_WRITE` para o `for update skip locked` da outbox.
- **Pipeline de migrations** — o schema nasce versionado e é propriedade das
  migrations, não de um gerador.

**O Unit of Work não é o mecanismo de escrita.** Ele estava nesta lista e
saiu: as escritas são `insert` e `nativeUpdate` explícitos, porque a corretude
depende da **ordem** dos statements dentro da transação, e ordem escolhida
pelo ORM no fim do commit não se revisa. A decisão, com o que ela custa, está
no [ADR-008](docs/adr/ADR-008-mapeamento-de-persistencia.md).

**Trade-off:** o MikroORM 7 só funciona em ESM e pede Node 22.17 ou mais
novo. Ele é mais lento que um driver cru, o que aqui pouco importa, já que o
gargalo deste domínio é o lock por wallet e não o mapeamento. O suporte a Bun
quem afirma é o próprio projeto, sem verificação independente o que existe
é evidência de execução: as migrations aplicam e revertem, e os repositórios
foram exercitados contra PostgreSQL 17.6 real.

O TypeORM ficou de fora. O enunciado o aceita, mas o Unit of Work dele é
implícito e transações aninhadas já renderam surpresas demais, risco que não
compensa num domínio onde atomicidade pesa mais.

Ver [ADR-003](docs/adr/ADR-003-mikroorm-e-migrations.md).

### 3.2 Mapeamento de `Money`

**Decidido e implementado.**

- Em memória, `Money` encapsula um `bigint` de centavos e uma moeda
  ISO-4217. Nunca `number`, nem na fronteira: `amount` entra e sai como
  **string decimal** com escala fixa de 2, validada por regex antes da
  conversão. Mais de duas casas é recusa, nunca arredondamento implícito. Ver
  [ADR-005](docs/adr/ADR-005-money-como-bigint-de-centavos.md).
- No banco, todo valor monetário é `numeric(20, 2)` — 18 dígitos inteiros e 2
  decimais, o mesmo limite que `MAX_INTEGER_DIGITS` e `MONEY_SCALE` declaram
  no domínio. No PostgreSQL, `numeric` é decimal exato; `double precision` não
  é, e a restrição 1 do enunciado é categórica.
- **Uma coluna `currency` por linha**, compartilhada pelos valores monetários
  dela, e não uma coluna de moeda por valor. Num lançamento, valor e saldos
  antes e depois são necessariamente da mesma moeda; com uma coluna por valor
  existiria linha representável com moedas internas divergentes, e seria
  preciso `check` extra para excluí-la. De quebra, a coerência de moeda entre
  a wallet e o que a referencia vira `foreign key (wallet_id, currency)`. O
  custo e a alternativa estão no
  [ADR-007](docs/adr/ADR-007-uma-moeda-por-linha.md).
- A conversão fica em mappers explícitos, não num custom type do ORM:
  `Money` precisa atravessar também a fila, a API e o payload da outbox, onde
  não há ORM nenhum. Ver
  [ADR-008](docs/adr/ADR-008-mapeamento-de-persistencia.md).
- Operações entre moedas diferentes lançam erro de domínio. O desafio permite
  assumir `BRL` único, mas o modelo continua multi-moeda e o conflito é
  testado — inclusive no schema, onde uma transação em moeda diferente da
  wallet é recusada pelo banco.

Coluna `numeric` em vez de tipo composto porque permite comparar e somar
dentro do próprio banco. A reconciliação
(`POST /wallets/:id/reconciliation`) precisa fazer isso sobre o ledger
inteiro, e trazer todas as linhas para a aplicação seria inviável. Há teste de
integração provando que a soma em `numeric` dentro do PostgreSQL e a soma de
`Money` em memória dão o mesmo resultado.

**Nenhuma biblioteca decimal foi instalada**, e não vai ser: o domínio só soma
e subtrai, `bigint` é exato e nativo, e a parte que justificaria a
dependência — arredondamento, multiplicação, câmbio — não existe neste
escopo.

### 3.3 Estratégia transacional

**Decidido e implementado.**

Uma transação SQL por operação de negócio, cobrindo a `WagerTransaction`, a
mudança de saldo da `Wallet`, o `WalletLedgerEntry`, o registro de inbox
quando a entrada vier da fila, e o evento na outbox.

A fronteira é `UnitOfWork.run`, e os repositórios **só existem dentro dela**:
são entregues ao callback, construídos sobre o `EntityManager` da transação.
Não é cerimônia, é o que impede uma escrita de escapar da transação, porque
fora de `run` não há objeto com que fazê-la. As duas garantias que mais
dependem disso são as que o enunciado trata como eliminatórias.

Dentro dessa transação o evento **não** é publicado: ele só é gravado na
outbox. Quem publica é um worker separado, depois do commit. É assim que a
restrição 4 do enunciado é atendida, e é para isso que a outbox existe.

## 4. Concorrência

**Decidido, implementado e provado sob concorrência real.**

A unidade de concorrência é a `walletId`. A estratégia é **locking pessimista
por wallet** (`SELECT ... FOR UPDATE` via `LockMode.PESSIMISTIC_WRITE`,
exposto como `WalletRepository.findByIdForUpdate`), com a versão da wallet
servindo de trilha de auditoria e de segunda barreira.

O cenário obrigatório da seção 8 — duas apostas de 80,00 numa wallet de
100,00 — foi executado com **três instâncias da API em processos separados**,
disparadas por uma barreira explícita: exatamente uma `PROCESSED`, exatamente
uma `REJECTED` com `INSUFFICIENT_FUNDS`, saldo final `20,00` e **um** único
lançamento de débito. Mais sete cenários da seção 13 acompanham, incluindo a
mesma aposta 50 vezes em paralelo com um débito só. Ver
[ADR-015](docs/adr/ADR-015-execucao-multi-instancia-e-testes-de-concorrencia.md).

E a prova de que a arbitragem é do banco, não do processo: no teste ponta a
ponta em contêiner, o replay de uma `Idempotency-Key` enviado a uma **terceira**
réplica devolveu o `transactionId` que a segunda havia gravado, com
`idempotentReplay: true`.

Três razões para preferir o pessimista ao otimista com retry:

1. O cenário obrigatório da seção 8 é uma **hot wallet**: duas apostas
   disputando o mesmo saldo. Com contenção de verdade, o otimista vira uma
   cascata de retries, e a conta chega justamente quando o sistema está sob
   carga.
2. O lock é por linha, nunca global. Wallets diferentes não se bloqueiam, o
   que atende à restrição 6.
3. Perguntar "tem saldo?" e debitar acontecem dentro do mesmo lock. Isso fecha
   a janela `read → calculate → update` da restrição 7 sem precisar reler
   nada.

**Trade-off:** o lock pessimista põe as operações da mesma wallet em fila e
mantém a transação aberta por mais tempo. Numa wallet muito movimentada, isso
se nota. A alternativa seria um update atômico condicional
(`update ... where balance >= :amount`), mais rápido, só que ele empurra regra
de negócio para dentro do SQL e complica o ledger, que precisa do saldo antes
e depois.

**Ordem de chegada não garante nada.** FIFO e `MessageGroupId` por wallet são
otimização: diminuem contenção e reentrega fora de ordem. Quem responde pela
corretude continua sendo o banco, como manda a restrição 3. Se a referência de
uma operação ainda não chegou, ela vira `PENDING_REFERENCE` e é reprocessada
depois — em nenhum momento se conta com a ordem do broker para resolver isso.

## 5. Idempotência

**Decidido e implementado nos dois caminhos de entrada.**

- A chave é o header `Idempotency-Key` no HTTP e o campo `idempotencyKey` do
  `data` na fila — mensagem não tem header de requisição. Default
  `{providerId}:{externalTransactionId}` nos dois. O que **não** muda é que
  ela fica fora do hash: a seção 9 diz que metadado de transporte não entra, e
  a chave é metadado de transporte nas duas portas.
- `payloadHash` = **SHA-256** sobre um **JSON canônico** do subconjunto de
  campos de negócio: `providerId`, `externalTransactionId`, `playerId`,
  `walletId`, `roundId`, `gameId`, `kind`, `money.amount`, `money.currency` e
  `referenceExternalTransactionId`, quando houver. Canônico aqui quer dizer
  chaves em ordem lexicográfica, sem espaços, e `amount` normalizado em 2
  casas. Header e metadados de transporte ficam de fora.
- Mesma chave e mesmo hash → replay: devolve a resposta original, com
  `idempotentReplay: true` e o saldo observado na ocasião.
- Mesma chave e hash diferente → **conflito**, não replay.
- Quem garante tudo isso é um índice único em `(idempotency_key)` no
  PostgreSQL, nunca cache em memória — restrição 2.

A escolha do SHA-256 vem de ele ser estável entre runtimes e largo o
suficiente para que colisão deixe de ser preocupação prática. Já normalizar o
`amount` antes do hash é essencial: `"25.0"` e `"25.00"` valem a mesma coisa
para o negócio e não podem acabar gerando conflito.

**São duas guardas, não uma, e elas respondem a perguntas diferentes.** A
`idempotency_key` protege contra a mesma **operação de negócio** submetida
duas vezes, por qualquer porta; o inbox protege contra a mesma **mensagem**
entregue duas vezes pelo broker. Uma operação reenviada com outro `messageId`
é pega pela primeira; uma mensagem reentregue é pega pela segunda, antes de o
domínio ser tocado. Colapsá-las deixaria um dos dois casos descoberto.

## 6. Mensageria e confiabilidade

**Decidido e implementado.**

- **Inbox** — deduplicação persistente por `(consumerName, messageId)`,
  gravada na mesma transação do efeito financeiro. É o que torna o redelivery
  inofensivo.
- **Ack só depois do commit.** Se o processo morrer entre um e outro, a
  mensagem reaparece e o inbox a reconhece como já processada.
- **Outbox** — eventos gravados no commit e publicados depois por um worker,
  com tentativas e backoff exponencial. Vários publishers concorrentes se
  coordenam por lock de linha com `SKIP LOCKED`: cada um pega o que o outro
  não pegou, e assim dois workers nunca disputam o mesmo evento nem ficam se
  bloqueando.
- **Classificação de erro** — erro de negócio é terminal e recebe ack; erro
  transitório vira retry com backoff; erro permanente vai para a DLQ.
- **DLQ** — `RedrivePolicy` com `maxReceiveCount` 5. Alto o bastante para
  absorver uma queda curta do PostgreSQL, baixo o bastante para tirar uma
  mensagem venenosa do caminho rápido.
- **`PENDING_REFERENCE`** — worker agendado com backoff exponencial, em
  **8 tentativas** espalhadas por **24 horas**. Esgotado o limite, a transação
  vira `REJECTED` com `REFERENCE_NOT_FOUND` e o evento correspondente é
  publicado. Vinte e quatro horas dão conta de um atraso operacional de um dia
  inteiro do provedor sem deixar a transação pendurada para sempre.

Duas decisões que o enunciado deixou abertas e precisaram ser tomadas aqui:

**Os eventos de integração saem em fila própria**, `wagering-events.fifo`, com
DLQ própria. O enunciado nomeia apenas as filas de entrada; publicar evento na
fila de entrada faria o próprio consumidor recebê-los de volta e precisar
filtrá-los por tipo. Nas duas direções o grupo é a `walletId` e o
`MessageDeduplicationId` é explícito — o `messageId` na entrada, o `eventId` na
saída. Ver [ADR-012](docs/adr/ADR-012-fila-de-saida-de-eventos.md).

**O publicador envia e só então marca, na mesma transação.** Entre o
`SendMessage` bem-sucedido e o `commit` existe um instante em que o processo
pode morrer, e aí o evento é publicado **de novo** por outra instância. Isso é
aceito de propósito: a alternativa — marcar antes de publicar — fecharia a
janela de duplicação e abriria a de **perda**. A seção 3 do enunciado lista
"perder eventos confirmados" como invariante global violada, enquanto a seção
11 diz que "uma publicação duplicada continua segura para o consumidor". A
escolha é dessa assimetria, não de preferência.

Ver [ADR-004](docs/adr/ADR-004-estrategia-de-confiabilidade.md),
[ADR-011](docs/adr/ADR-011-consumidor-sqs-e-inbox-transacional.md) e
[ADR-013](docs/adr/ADR-013-modelo-de-execucao-dos-workers.md).

## 7. Códigos de falha e status HTTP

**Decidido e implementado.**

Os códigos são estáveis e legíveis por máquina, e dão ao provedor o que ele
precisa para decidir se reenvia, corrige o payload ou desiste:

| Código                    | Situação                                                  | HTTP |
| ------------------------- | --------------------------------------------------------- | ---- |
| `VALIDATION_FAILED`       | payload malformado ou fora do contrato                    | 400  |
| `IDEMPOTENCY_CONFLICT`    | mesma chave, payload divergente                           | 409  |
| `WALLET_ALREADY_EXISTS`   | wallet duplicada para player e moeda                      | 409  |
| `WALLET_NOT_FOUND`        | wallet inexistente                                        | 404  |
| `TRANSACTION_NOT_FOUND`   | transação inexistente, pelos dois caminhos de consulta    | 404  |
| `CURRENCY_MISMATCH`       | moeda da operação difere da wallet                        | 422  |
| `INSUFFICIENT_FUNDS`      | `BET` sem saldo                                           | 422  |
| `REVERSAL_WOULD_OVERDRAW` | reversão deixaria saldo negativo                          | 422  |
| `REFERENCE_NOT_FOUND`     | referência não apareceu no prazo                          | 422  |
| `REFERENCE_MISMATCH`      | referência de outro contexto, ou em estado não revertível | 422  |
| `REFERENCE_KIND_INVALID`  | o tipo da referência não admite esta reversão             | 422  |
| `ALREADY_REVERSED`        | referência já revertida por esse tipo                     | 422  |
| `AMOUNT_MISMATCH`         | valor difere do da referência                             | 422  |
| `TRANSPORT_UNAVAILABLE`   | PostgreSQL ou SQS indisponível                            | 503  |

O mapa é um `Record` **total** sobre a taxonomia, em
`src/interfaces/http/failure-http.ts`: um código novo sem status definido não
compila. A alternativa seria um default silencioso, que mandaria 500 para uma
recusa de negócio.

A linha que separa 400 de 422 foi traçada de propósito: **400 quer dizer que a
requisição está errada; 422, que ela está correta e o negócio a recusou.**
Reenviar um 400 sem mexer no payload não leva a lugar nenhum, enquanto um 422
é resposta final sobre um pedido bem formado. `REVERSAL_WOULD_OVERDRAW` ficou
separado de `INSUFFICIENT_FUNDS` porque as duas situações pedem reações
diferentes: a segunda é rotina, e a primeira indica que provedor e plataforma
estão com visões divergentes do estado, o que merece investigação.

O `202 Accepted` fica reservado para `PENDING_REFERENCE`: aceita, mas ainda
não aplicada.

### 7.1 Interpretações adicionais

A seção 7 do enunciado exige que qualquer interpretação adicional seja
documentada. São estas oito, cada uma com a razão e o custo.

**1. Recusa anterior à transação não persiste transação.** Wallet
inexistente, moeda divergente e player que não é dono da wallet respondem com
`failureCode` e **sem** `transactionId`. A razão é estrutural: a foreign key
composta `(wallet_id, currency)` torna irrepresentável uma transação para
wallet inexistente ou em outra moeda, então não há linha a gravar. O custo é
que essas tentativas não ficam auditáveis no ledger de transações. Não há
perda de idempotência — nenhuma delas produziu efeito, e é efeito duplicado
que a idempotência impede.

**2. Recusa por regra de negócio persiste e publica.** Saldo insuficiente,
reversão que estouraria o saldo, referência inválida e reversão duplicada são
gravadas como `REJECTED`, com `transactionId` na resposta e evento
`WagerTransactionRejected` na outbox. Recusa é resultado de uma avaliação, não
falha, e o provedor precisa poder consultá-la depois.

**3. `REFERENCE_MISMATCH` cobre estado, não só identidade.** Uma referência
`REJECTED` ou `FAILED` existe e nunca aplicou efeito: não há o que reverter.
Isso é recusa terminal com este código, cujo sentido documentado passa a ser
"a referência existe e não corresponde a uma transação revertível". Referência
ainda em `PENDING` ou `PENDING_REFERENCE` **não** cai aqui: ela pode virar
`PROCESSED`, e desistir agora recusaria uma reversão legítima por acidente de
temporização — vira `PENDING_REFERENCE`, como a regra 8 manda.

**4. A referência opcional de `WIN` é informativa.** A tabela da seção 7 diz
que `WIN` "pode referenciar a `BET` da mesma rodada", e as regras 3 e 5 falam
de `REFUND` e `ROLLBACK`. Se a referência de um `WIN` resolve na mesma wallet,
o id interno é guardado para rastreio; se não resolve, o `WIN` é aplicado de
todo modo. Recusar um crédito legítimo por um campo opcional que não resolveu
seria mais severo do que o enunciado pede.

**5. A transação `OPENING` usa um provedor reservado.** As colunas de
identificação externa são `not null`, e a abertura de wallet não vem de
provedor nenhum. `providerId` recebe `internal`, e `externalTransactionId`,
`idempotencyKey` e `roundId` recebem `opening:{walletId}`. Mantém o schema
estrito para os 99% dos casos em vez de tornar quatro colunas anuláveis por
causa de um caso interno.

**6. A abertura de wallet publica eventos.** As regras da seção 11 valem como
escritas: o crédito de abertura **é** uma transação aplicada e **é** uma
mudança de saldo, então saem `WagerTransactionProcessed` e
`WalletBalanceChanged`. Sem isso, um consumidor que reconstrói saldo a partir
dos eventos veria a wallet nascendo em zero.

**7. Transação aplicada responde `200`, não `201`.** A seção 9 promete que
requisição idêntica devolve **a mesma resposta**. Com `201` no original e `200`
no replay, a promessa não valeria literalmente. Quem informa que houve replay é
o campo `idempotentReplay`.

**8. Cursor ilegível e `limit` acima do teto são `400`.** Nos dois casos a
alternativa silenciosa seria pior: cursor inválido devolvendo a primeira página
transforma paginação defeituosa em loop que parece normal, e `limit` truncado
entrega menos do que o cliente pediu sem dizer. O teto de `limit` é 200, e
existe porque o parâmetro é do cliente — sem ele, `limit=1000000` vira
varredura do ledger inteiro.

## 8. Autenticação

**Decidido: não implementar.** A seção 2 do enunciado permite, e diz com todas
as letras que autenticação não vale pontos.

A razão é simples: 70 dos 100 pontos estão em correção financeira,
concorrência, idempotência e mensageria. Implementar autenticação tiraria
tempo dessas áreas sem somar um ponto sequer.

Se fosse implementar, o desenho seria este: **Keycloak** subindo no Docker
Compose como Identity Provider externo, via OIDC, com a API validando o JWT
por JWKS, sem tabela própria de usuários e sem hash de senha em lugar
nenhum. O `providerId` do token seria conferido contra o `providerId` do
payload.

O ponto de extensão **existe e é chamado**: a porta `ProviderIdentityPort`, em
`application/ports`, com implementação no-op em `infrastructure/system`. O caso
de uso de submissão invoca `resolve` e, quando a identidade vem autenticada,
exige que o `providerId` dela coincida com o do payload — a conferência
descrita acima. Com o no-op a resposta é sempre "canal sem identidade", então
nada é recusado; trocar a implementação por uma que valide JWT por JWKS liga a
verificação sem tocar em caso de uso nenhum.

Ponto de extensão que ninguém chama é interface pendurada, então há teste de
unidade exercitando o caminho autenticado — incluindo que a recusa acontece
**antes** de qualquer transação abrir. De todo modo, a validação de domínio
sobre o `providerId` da mensagem acontece: a fila é canal interno confiável
quanto ao transporte, não quanto ao conteúdo que trafega nela.

Os health checks ficam abertos, como pede a seção 9 do enunciado. Essa parte
já está implementada.

## 9. Observabilidade

**Decidido e implementado.**

Já existe: `GET /health/live` e `GET /health/ready`, separados. O liveness não
encosta em dependência nenhuma, e isso tem motivo. Um liveness que consulta o
banco faz o orquestrador reiniciar uma aplicação saudável toda vez que o
PostgreSQL oscila — a pior reação possível diante de uma instabilidade
passageira. O readiness checa o PostgreSQL com uma consulta de verdade e o SQS
com `GetQueueUrl`, e devolve 503 dizendo o que falhou.

**Cada verificação tem prazo próprio, e isso é o que faz a separação acima
valer algo.** Timeout é indisponibilidade: uma dependência que aceita a
conexão e nunca responde não falha por conta própria nunca, e sem prazo o
readiness também não responderia — ficando indistinguível de um processo
quebrado, que é exatamente a distinção que esses dois endpoints existem para
permitir. O cliente SQS tem `requestTimeout`, `connectionTimeout` e
`throwOnRequestTimeout`; o readiness impõe um prazo mais curto por requisição,
com `AbortSignal`, porque o transporte precisa tolerar um long poll de 20 s e
uma sonda não. Medido: 503 em 2,02 s contra um SQS calado, onde antes a
resposta não vinha. Ver
[ADR-009](docs/adr/ADR-009-prazos-explicitos-de-indisponibilidade.md).

**Logs estruturados em JSON**, uma linha por registro, escritos direto em
`stdout`. Os cinco campos que a seção 12 pede — `correlationId`, `messageId`,
`transactionId`, `walletId`, `providerId` — ficam no topo do objeto, para que
um coletor consulte por correlação sem conhecer a forma do nosso envelope.

Não passa pelo `Logger` do Nest, e isso não é preferência: o logger do Nest
prefixa cada linha com carimbo de tempo, nome de contexto e códigos de cor
ANSI, e qualquer um dos três quebra o parsing da linha como JSON — que é o
único motivo de o formato ser JSON.

A proibição de payload financeiro **já estava garantida pelo tipo**: o
`LogContext` só aceita escalares, então não há como passar um objeto de
domínio por engano.

**Onze métricas** em `GET /metrics`, em texto Prometheus, **sem nenhuma
dependência de runtime** — as sete que a seção 12 exige, mais a de
reconciliação que a seção 9 pede, mais contagem de mensagens recebidas,
eventos publicados e profundidade da outbox:

| Métrica                                | O que mede                           |
| -------------------------------------- | ------------------------------------ |
| `wagering_transactions_total`          | transações por tipo, status e origem |
| `wagering_duplicates_detected_total`   | duplicatas, por guarda que recusou   |
| `wagering_retries_total`               | retentativas, por assunto            |
| `wagering_dlq_messages_total`          | mensagens à DLQ, por motivo          |
| `wagering_lock_conflicts_total`        | conflitos de concorrência            |
| `wagering_outbox_pending_age_seconds`  | **outbox lag**                       |
| `wagering_processing_duration_seconds` | latência, por operação e desfecho    |
| `wagering_reconciliation_checks_total` | reconciliações, consistente ou não   |

Toda série é emitida **em zero** antes da primeira observação. Não é
organização: é o que distingue "não aconteceu" de "não está instrumentado" —
série que só nasce no primeiro evento faz o gráfico pular de "sem dados" para
um valor, e quem olha não sabe qual dos dois está vendo.

O registry é **por processo**, de propósito: agregar é trabalho do coletor,
que é quem sabe quantas instâncias existem. Efeito colateral útil: o
`/metrics` de cada processo serve de prova de que aquele processo trabalhou, e
os testes de concorrência usam isso para demonstrar paralelismo real em vez de
inferi-lo de tempos.

Ver [ADR-014](docs/adr/ADR-014-observabilidade-sem-dependencia-nova.md), que
registra também por que `prom-client` ficou de fora e em que condição vale
revisitar.

## 10. Infraestrutura local

**Decidido, implementado e validado.**

PostgreSQL 17.6 e MiniStack 1.5.33 no `docker-compose.yml`, os dois com versão
fixada e healthcheck. O PostgreSQL é publicado na **5433** do host para não
colidir com uma instalação nativa na 5432.

MiniStack no lugar do LocalStack. A edição Community do LocalStack foi
descontinuada em março de 2026, a imagem atual exige token e o plano gratuito
proíbe uso comercial. Obrigar quem vai avaliar o projeto a criar conta
atrapalha a reprodução sem devolver nada em troca. O MiniStack é MIT, roda sem
conta e atende no mesmo endpoint `:4566` — por isso a escolha não aparece em
lugar nenhum do código da aplicação, só no `.env`.

**Trade-off:** o MiniStack é bem menos maduro, e quem garante o suporte a
FIFO, deduplicação e DLQ é o próprio projeto, sem verificação independente
publicada. A documentação dele nem chega a descrever como configurar a
`RedrivePolicy`. Foi por isso que as quatro capacidades acabaram testadas uma
a uma em `test/integration/sqs-fifo-dlq.spec.ts`, contra o emulador real — e
todas **passaram**: fila FIFO com `RedrivePolicy`, entrega com
`MessageGroupId`, deduplicação por `MessageDeduplicationId` e redrive para a
DLQ ao esgotar o `maxReceiveCount`. A reserva que pesava sobre esta decisão
caiu por teste, não por confiança na documentação.

O que os testes **não** cobrem é a equivalência com o SQS da AWS nas bordas: a
janela de deduplicação de cinco minutos e a ordenação estrita por grupo sob
contenção. Se alguma delas divergir de forma relevante, a saída é voltar ao
LocalStack fixado numa versão anterior ao fim da Community — uma linha no
Compose e outra no `.env`, sem encostar no código.

Ver [ADR-002](docs/adr/ADR-002-ministack-como-emulador-sqs.md).

## 11. Limitações conhecidas

Em ordem de quanto pesam.

1. **A equivalência entre MiniStack e o SQS da AWS não é total nem foi
   medida.** As quatro capacidades de que o desenho depende passaram contra o
   emulador real — fila FIFO com `RedrivePolicy`, entrega com
   `MessageGroupId`, deduplicação por `MessageDeduplicationId` e redrive ao
   esgotar o `maxReceiveCount` —, mas a **janela de deduplicação de cinco
   minutos** e a **ordenação estrita por grupo sob contenção** ficaram de
   fora. As duas importam: a primeira é a otimização que torna a republicação
   da outbox invisível ao consumidor, e a segunda é o que reduz contenção na
   entrada. Nenhuma das duas é garantia de corretude — essa é do banco, pela
   restrição 3 —, mas se divergirem, o sistema fica mais lento e mais
   repetitivo do que o medido aqui. A saída é voltar ao LocalStack fixado numa
   versão anterior ao fim da Community: uma linha no Compose e outra no
   `.env`. Ver [ADR-002](docs/adr/ADR-002-ministack-como-emulador-sqs.md).

2. **Nada foi medido sob carga.** Os testes de concorrência provam
   **corretude** com paralelismo real — 50 submissões simultâneas, três
   instâncias, dois publicadores —, não desempenho. Não há número de
   throughput, nem latência percentil, nem outbox lag sob pressão, nem
   evidência de como o lock pessimista por wallet se comporta com uma hot
   wallet de verdade. O `bun run test:load` que o enunciado sugere como
   diferencial não existe, e isso é escolha de escopo, não esquecimento: a
   seção 14 o trata como opcional, e os 100 pontos obrigatórios vinham
   primeiro.

3. **A janela de republicação da outbox é real.** Um processo que morra entre
   o `SendMessage` e o `commit` faz outra instância republicar o evento. É
   decisão consciente (seção 6), e a defesa é o `MessageDeduplicationId` mais
   o inbox de quem consome — ou seja, **depende de o consumidor externo ser
   idempotente**, e isso não está sob nosso controle. Para o consumidor
   interno, está testado.

4. **Mensagem para wallet inexistente é descartada.** Pela fila, ela é recusa
   de negócio terminal e recebe `ack` — a mesma resposta que o HTTP dá. O
   enunciado prevê reprocessamento fora de ordem apenas para **referências de
   transação** (seção 7.1), não para wallets, então a interpretação é
   consistente com o texto. Mas se um provedor submeter antes de a wallet
   existir, a operação se perde, e a recuperação é manual.

5. **A regra de dependência entre camadas depende de revisão de código.** Nada
   no build impede um import que a viole. Uma regra de ESLint sobre caminhos
   de import conferiria isso automaticamente, e sai bem mais barato do que
   descobrir a violação depois. Não foi escrita.

6. **MikroORM sobre Bun foi exercitado, com limite.** Conexão, transações,
   savepoints aninhados, migrations, `EntitySchema`, lock pessimista e
   `skip locked` funcionam contra PostgreSQL 17.6 real, inclusive sob
   concorrência de três processos. O suporte a Bun quem afirma é o próprio
   projeto do MikroORM, sem verificação independente; o que existe aqui é
   evidência de execução, não garantia do fornecedor.

7. **Dois caminhos de execução a manter.** O `Dockerfile` e o
   `spawnInstance` dos testes de concorrência sobem a mesma aplicação por
   meios diferentes, e uma variável de ambiente nova precisa ser acrescentada
   nos dois. Só o Compose falharia de forma óbvia. Ver
   [ADR-015](docs/adr/ADR-015-execucao-multi-instancia-e-testes-de-concorrencia.md).

8. **A fila de saída não tem consumidor.** Ela acumula até a retenção de
   quatro dias expirar. É o comportamento correto de um produtor de eventos, e
   ainda assim parece lixo acumulado para quem abrir o emulador.

9. **Sem autenticação**, por decisão registrada na seção 8. O ponto de
   extensão existe, é chamado e está testado.

10. **Sem tracing distribuído.** O `correlationId` atravessa o sistema e
    aparece nos logs, mas não há propagação de contexto nem spans. O enunciado
    trata OpenTelemetry como opcional.

11. **O formato de exposição das métricas é nosso.** Texto Prometheus
    `version=0.0.4`, sem `_created`, sem exemplars, sem OpenMetrics. Um
    coletor que exija qualquer um desses não é atendido. Ver
    [ADR-014](docs/adr/ADR-014-observabilidade-sem-dependencia-nova.md).

## 12. Se houvesse mais tempo

Em ordem do que daria mais retorno.

1. **Teste de carga** (`bun run test:load`), com ambiente, metodologia,
   throughput, p50/p95/p99, taxa de erro, conflitos de concorrência e outbox
   lag registrados — é a limitação 2, e é o diferencial que o enunciado
   descreve.
2. **Medir a divergência entre MiniStack e o SQS da AWS** nas duas bordas que
   ficaram de fora: janela de deduplicação e ordenação por grupo sob
   contenção. É a limitação 1, e é a que mais muda o que se pode afirmar.
3. **Regra de ESLint para a fronteira entre camadas**, trocando revisão humana
   por verificação automática.
4. **Autenticação com Keycloak via OIDC**, substituindo o `ProviderIdentityPort`
   no-op por uma implementação que valide JWT por JWKS. O desenho está na
   seção 8; o ponto de extensão já é chamado.
5. **Renovação de visibilidade durante o processamento**, para o caso de o
   pior tempo de uma transação se aproximar do `VisibilityTimeout` de 30 s.
6. **Tracing distribuído**, aproveitando o `correlationId` que já existe.
