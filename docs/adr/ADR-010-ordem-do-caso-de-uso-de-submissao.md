# ADR-010 — A ordem do caso de uso de submissão

- **Status:** Aceito e implementado
- **Data:** 2026-10-30
- **Decidido por:** Patrick Oliveira

## Contexto

O ADR-004 fixou que a idempotência é decidida por **constraint**, não por
verificação: "o caminho é inserir direto e tratar a violação de unicidade como
fluxo normal". Consultar antes de inserir é `read → calculate → update` com
outro nome, e duas instâncias o atravessam juntas sem perceber.

O ADR-006 acrescentou uma coisa que não existia quando o ADR-004 foi escrito:
a foreign key composta `(wallet_id, currency)` → `wallets (id, currency)`. Ela
torna **irrepresentável** uma transação para wallet inexistente ou em moeda
diferente da wallet.

As duas decisões colidem. Inserir a transação antes de olhar a wallet produz,
nesses dois casos, violação de **chave estrangeira** — que o adapter não
classifica como caminho de negócio e repassa como erro. O provedor receberia
500 onde precisa de `WALLET_NOT_FOUND` ou `CURRENCY_MISMATCH`, que são
informações acionáveis: a primeira diz "confira o walletId", a segunda, "a
wallet é em outra moeda".

## Decisão

A wallet é carregada **sob lock antes** da inserção da transação. A ordem
completa:

1. **Identidade do provedor**, se o canal a traz (seção 2). Divergência é
   recusa, e acontece antes de qualquer transação abrir.
2. **Hash do payload de negócio** — sem header, sem metadado de transporte.
3. Abre a transação SQL.
4. **Wallet sob `SELECT ... FOR UPDATE`.** Ausente → `WALLET_NOT_FOUND`.
   Dono diferente → `VALIDATION_FAILED`. Moeda diferente →
   `CURRENCY_MISMATCH`. Nenhuma das três persiste transação.
5. **Insere a transação**, isolada em savepoint. A colisão de unicidade é
   caminho normal, e cada uma tem um sentido: chave de idempotência,
   `(provider, id externo)` ou reversão duplicada.
6. **Resolve a referência**, com as regras 2, 3 e 5 da seção 7.
7. **Aplica**: lançamento no ledger, saldo, transação e evento na outbox, no
   mesmo commit.

### Por que isso não enfraquece a idempotência

O ADR-004 proíbe **consultar a transação** antes de inserir, porque a
existência dela é o que a unicidade decide. Isso continua valendo: o passo 5 é
a inserção, e é ela que escolhe o vencedor entre duas tentativas concorrentes.

O passo 4 não consulta a transação — consulta a **wallet**, que é outro fato,
e um fato que não muda de existência: não há exclusão de wallet no sistema.
Uma wallet que existe no passo 4 existe no passo 5. E ela é lida **sob lock**,
que é exatamente onde o ADR-004 queria o lock para a decisão de saldo.

O caso que importa, duas requisições idênticas simultâneas, continua resolvido
pelo banco: as duas pegam o lock em sequência, a primeira insere e comita, a
segunda colide na unicidade e devolve replay.

### Desfecho é resultado, não exceção

Os casos de uso devolvem união discriminada, não lançam. `recorded` carrega a
transação persistida — `PROCESSED`, `REJECTED` ou `PENDING_REFERENCE` — e
`refused` carrega só o código, para as recusas anteriores à transação.

Recusa de negócio é desfecho de uma avaliação, não falha. Modelá-la como
exceção faria o caminho normal do sistema passar por `try`/`catch`, e
misturaria no mesmo mecanismo duas coisas diferentes: "o negócio disse não" e
"algo quebrou". Exceção fica para violação de invariante e falha de
transporte, que é o que ela deve significar.

## Verificação

`test/integration/api.spec.ts`: 49 casos contra PostgreSQL 17.6 real, com a
aplicação no ar — `ConfigModule`, `PersistenceModule` e `ApiModule`, casos de
uso compostos como em produção, **nenhum repositório substituído**.

Entre eles: replay devolvendo a mesma resposta com `idempotentReplay: true`,
mesma chave com payload divergente dando 409, formatação diferente do mesmo
valor sendo replay e não conflito, recusa por saldo deixando saldo e `version`
intactos, reversão duplicada recusada e **auditável**, referência ausente
respondendo 202 com agendamento, e `ROLLBACK` de `WIN` que não cabe recebendo
`REVERSAL_WOULD_OVERDRAW`. Em todo cenário que move saldo, a invariante global
da seção 13 é conferida contra as duas tabelas.

Os casos de uso **não** têm teste de unidade com repositório em memória, e é
decisão: um repositório falso não reproduz o savepoint, o lock de linha nem as
constraints — que é onde a corretude deste caso de uso mora. Testar contra ele
daria verde sem evidência. O que tem teste de unidade é o que é puro: contratos
de entrada, cursor, mapa de status, presenters, agenda de retentativa e a
costura de identidade.

## Consequências

**Positivas**

- O provedor recebe código acionável onde antes receberia 500.
- O lock é tomado uma vez, no ponto em que a decisão de saldo vai acontecer.
- A ordem é legível de cima para baixo no código, porque as escritas são
  explícitas (ADR-008) em vez de um flush no fim.
- Recusa de negócio não passa por exceção, então o caminho normal não tem
  `catch`.

**Negativas**

- **O replay paga o lock.** Uma requisição repetida toma o lock da wallet
  antes de descobrir que é replay, e portanto serializa contra operações
  legítimas daquela wallet. Numa wallet muito movimentada com provedor que
  reenvia muito, isso se nota. A alternativa — consultar a idempotência antes
  do lock — reintroduziria a leitura que o ADR-004 descartou como garantia, e
  não foi aceita como otimização.
- **Recusa anterior à transação não fica auditável.** Wallet inexistente e
  moeda divergente não deixam linha, porque o schema não admite uma. Está
  declarado na seção 7.1 do `ARCHITECTURE.md`.
- A união discriminada obriga o controller a tratar os dois ramos. É mais
  verboso que um `catch` único — e é o ponto: o compilador cobra o tratamento.
- Esta ordem **parece** contradizer o ADR-004 para quem ler os dois em
  sequência, e por isso a seção "Por que isso não enfraquece a idempotência"
  existe.

**Neutras**

- A reversão duplicada é o único caso em que a transação é marcada `REJECTED` e
  inserida numa segunda tentativa: o índice parcial que a recusou cobre apenas
  os estados vivos, então a linha recusada cabe. É o que a torna auditável.

## Alternativas consideradas

**Inserir a transação primeiro e classificar a violação de chave estrangeira.**
Descartada. Exigiria o adapter distinguir _qual_ foreign key falhou para
decidir entre `WALLET_NOT_FOUND` e `CURRENCY_MISMATCH` — e a mensagem do
PostgreSQL não separa as duas, porque é a **mesma** constraint composta. O
provedor receberia um código só para duas situações diferentes.

**Tornar `(wallet_id, currency)` duas foreign keys separadas**, para
distinguir as violações. Descartada: `(wallet_id, currency)` composta é
justamente o que propaga a moeda da wallet (ADR-007), e separá-la devolveria o
problema que ela resolve.

**Consultar a idempotência antes de tomar o lock, como otimização.**
Descartada. Economizaria o lock no replay e acrescentaria um caminho de leitura
que decide fluxo — exatamente a forma que o ADR-004 recusou. Numa decisão
financeira, dois mecanismos de idempotência convivendo é um a mais do que o
necessário para errar.

**Lançar exceção de domínio para recusa de negócio e traduzir num filtro.**
Descartada. Funciona, e faz o caminho mais comum do sistema — aposta recusada
por saldo — passar por desvio de fluxo. Além disso, a recusa precisa devolver
`transactionId`, `status` e `balance`, que são dados de sucesso: embrulhá-los
numa exceção para desembrulhar num filtro é cerimônia sem ganho.

**Testar os casos de uso com repositórios em memória.** Descartada, com a
razão na seção de verificação: o dublê não reproduz savepoint, lock nem
constraint, que é o que há para verificar aqui.

## Revisitar quando

- A medição mostrar que o lock tomado por replays é gargalo real, o que
  dependeria de um provedor com taxa alta de reenvio.
- Entrar exclusão ou arquivamento de wallet no escopo, porque aí a premissa
  "wallet que existe continua existindo" deixa de valer entre os passos 4 e 5.
- O caminho da fila (etapa seguinte) exigir uma ordem diferente, caso em que os
  dois pontos de entrada precisariam convergir ou o motivo da divergência ser
  registrado.
