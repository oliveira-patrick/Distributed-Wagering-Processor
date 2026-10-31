# ADR-011 — Consumidor SQS: inbox na mesma transação e ack após commit

- **Status:** Aceito e implementado
- **Data:** 2026-10-30
- **Decidido por:** Patrick Oliveira

## Contexto

A seção 10 do enunciado impõe três coisas ao consumidor, e elas interagem:

1. **reutilizar o mesmo use case da entrada HTTP** — não um caminho paralelo;
2. **deduplicar via inbox persistente** por `(consumerName, messageId)`;
3. **fazer `ack` somente após o commit**.

A seção 6.5 fecha o cerco: "Inbox, alteração financeira, ledger e outbox
participam da **mesma transação SQL**".

O `SubmitWagerTransactionUseCase` que atendia o HTTP abria a própria transação
dentro de `execute`. Com a fronteira transacional lá dentro, o consumidor não
conseguia atender (2) e (3) ao mesmo tempo sem violar (1): ou duplicava a
lógica de submissão para poder gravar o inbox no mesmo commit, ou gravava o
inbox numa transação à parte.

A segunda opção parece inofensiva e não é. Com duas transações há uma janela
entre elas, e nessa janela o processo pode morrer:

- inbox comitado, efeito não → a mensagem é reentregue, o inbox a reconhece
  como processada, e **o efeito financeiro nunca acontece**. Aposta perdida.
- efeito comitado, inbox não → a mensagem é reentregue, o inbox não a
  reconhece, e o efeito é aplicado **de novo**. É "débito duplicado", falha
  eliminatória no enunciado — salvo pela idempotência por `idempotency_key`,
  que de fato salvaria, mas aí o inbox não está servindo para nada.

## Decisão

Dividir o caso de uso de submissão em três métodos, e dar a fronteira
transacional a **quem chama**:

- `prepare(input)` — fora de qualquer transação: resolve a identidade do
  provedor e calcula o `payloadHash`;
- `executeWithin(repositories, input, payloadHash)` — o corpo transacional,
  sobre repositórios que já estão numa transação; **não** abre transação;
- `execute(input)` — o caminho HTTP: `prepare`, abre a transação, delega.

O `ConsumeWagerMessageUseCase` usa os dois primeiros: `prepare` fora, e dentro
da sua própria transação grava o inbox e chama `executeWithin`.

### Por que `prepare` fica fora da transação

Resolver a identidade do provedor é E/S — num IdP de verdade, uma consulta de
JWKS. Mantida dentro da transação, ela seguraria o lock da wallet pelo tempo
de uma chamada de rede alheia, e a seção 8 trata contenção de wallet como o
problema central. O hash é puro e sai junto porque também não depende do
banco.

### A ordem dentro da transação do consumidor

```
begin
  insert inbox (consumer_name, message_id)   -- colisão = duplicata
  …efeito financeiro, ledger, outbox…        -- executeWithin
  update inbox set processed_at
commit
ack
```

O inbox é inserido **primeiro**, e a colisão da chave primária composta é a
resposta da deduplicação — o mesmo padrão da idempotência por constraint do
[ADR-010](ADR-010-ordem-do-caso-de-uso-de-submissao.md), pela mesma razão:
consultar antes de inserir devolveria "não existe" para duas entregas
concorrentes da mesma mensagem.

O efeito financeiro vem depois e pode falhar, levando o inbox embora no
rollback. Isso é o comportamento **correto**: a mensagem precisa voltar pela
fila.

### Classificação de erro em três, não em duas

| Classe          | Reconhecido por         | Reação                        |
| --------------- | ----------------------- | ----------------------------- |
| **negócio**     | desfecho do caso de uso | terminal, `ack`               |
| **transitório** | `isTransportFailure`    | sem `ack`; volta pela fila    |
| **permanente**  | `PermanentMessageError` | `ack` + envio explícito à DLQ |

Negócio sai como **valor de retorno**; transporte sai como **exceção**. A
separação por tipo, e não por campo, é o que impede o consumidor de confirmar
uma mensagem cujo commit não aconteceu — não há como esquecer de checar um
campo que não existe.

"Permanente" é payload que não melhora na reentrega: corpo vazio, JSON
inválido, tipo desconhecido, payload fora do contrato. Esse vai direto à DLQ,
em vez de gastar as cinco entregas do `maxReceiveCount` para chegar ao mesmo
lugar ocupando o consumidor.

**Erro inesperado — um bug nosso — é tratado como transitório.** É a escolha
conservadora: classificá-lo como permanente descartaria na primeira tentativa
uma operação financeira que talvez passasse na segunda. Insistindo, o
`maxReceiveCount` acaba levando à DLQ de todo modo, mas depois de cinco
chances em vez de zero.

### Grupos em paralelo, mensagens do grupo em sequência

Uma chamada de `ReceiveMessage` numa fila FIFO pode trazer várias mensagens do
mesmo `MessageGroupId`, em ordem. Processá-las em paralelo jogaria fora a
ordenação que a fila acabou de garantir e poria duas operações da mesma wallet
disputando o mesmo lock. Grupos diferentes são wallets diferentes e não se
bloqueiam — esses vão juntos.

### Encerramento gracioso

No `SIGTERM`: para de receber, **cancela o `ReceiveMessage` em curso** com
`AbortSignal`, espera o lote em andamento até `WORKER_SHUTDOWN_TIMEOUT_MS` e,
se o prazo estourar, devolve a visibilidade das mensagens restantes com
`ChangeMessageVisibility(0)`.

O cancelamento não é detalhe: sem ele, parar o consumidor esperaria o long
poll inteiro — vinte segundos —, muito além do intervalo que o Compose dá
entre `SIGTERM` e `SIGKILL`. O resultado seria um shutdown "gracioso" que
nunca termina a tempo.

## Verificação

Contra PostgreSQL 17.6 e MiniStack reais, em
`test/integration/sqs-consumer.spec.ts` (8 casos):

- mensagem processada uma vez, efeito no banco, fila vazia depois;
- linha de inbox gravada com `processed_at` já preenchido — nunca existe
  inbox sem marcação depois de o commit confirmar;
- os eventos da seção 11 na outbox, no mesmo commit;
- **a mesma `messageId` publicada duas vezes produz um único débito**, com uma
  linha de inbox só;
- recusa por regra de negócio é terminal: `REJECTED`, saldo intacto, sem
  lançamento, mensagem confirmada;
- JSON inválido, `OPENING` pela fila e tipo desconhecido vão à DLQ.

A **ordem** `ack` depois do commit está em `test/unit/sqs-consumer.spec.ts`
(12 casos), que usa um dublê do cliente do SDK e o declara no topo do arquivo.
A escolha é deliberada: o que se verifica ali é a sequência de comandos que o
consumidor emite, e provar sequência contra um serviço real exigiria travá-lo
sob demanda, o que não é determinístico. Os casos cobrem: `DeleteMessage`
depois de o caso de uso retornar; nenhum `DeleteMessage` quando o
processamento falha; `SendMessage` à DLQ **antes** do `DeleteMessage` da
original; grupos em paralelo e mesmo grupo em sequência; e `stop` terminando
dentro do prazo.

## Consequências

**Positivas**

- A lógica de submissão existe **uma vez**. HTTP e fila entram pelo mesmo
  `executeWithin`, e uma regra nova vale para os dois sem ninguém se lembrar.
- Inbox e efeito financeiro são atômicos por construção, não por disciplina.
- O consumidor não conhece o domínio: ele recebe, valida envelope, delega e
  decide `ack`. Toda regra de negócio está do outro lado da porta.
- A janela entre commit e `ack` continua existindo — ela é inevitável — mas
  passou a ser inofensiva, e há teste que a exercita.

**Negativas**

- **A classe de submissão cresceu.** Ela agora expõe `prepare`,
  `executeWithin`, `execute` e `retryReferenceWithin`, e um leitor precisa
  entender qual chamar. A assimetria mais perigosa é que `execute` registra
  métrica e `executeWithin` não — está documentado nos dois métodos, e é o
  tipo de coisa que um comentário protege mal.
- Quem chama `executeWithin` é responsável pela transação, e nada no tipo
  obriga a existir uma. Passar repositórios fora de `UnitOfWork.run` é
  impossível por construção (eles só existem dentro dela), o que mitiga —
  mas a garantia é indireta.
- A classificação de erro mora no adapter de SQS, não no domínio. Um segundo
  transporte — Kafka, por exemplo — reimplementaria a decisão.

**Neutras**

- `prepare` devolver um `Refusal` significa que uma recusa de identidade não
  grava inbox. Reentregar produz a mesma recusa, sem efeito nenhum, então não
  há perda de idempotência.
- Wallet inexistente pela fila é recusa de negócio, terminal, e recebe `ack`.
  É a mesma resposta que o HTTP dá (404), e manter as duas entradas
  consistentes é o que a seção 10 pede ao exigir o mesmo use case. O custo é
  que uma mensagem que chegasse antes da criação da wallet seria descartada;
  o enunciado prevê reprocessamento fora de ordem apenas para **referências**
  de transação, na seção 7.1, não para wallets.

## Alternativas consideradas

**Duas transações: inbox numa, efeito noutra.** Descartada. A janela entre
elas perde ou duplica operação financeira, como o Contexto detalha.

**Um `beforeEffect` opcional no input do caso de uso**, para o consumidor
injetar a gravação do inbox. Descartada: é um callback dentro de um DTO, que
inverte o controle de forma difícil de ler, e deixaria a assinatura do
caminho HTTP carregando um campo que ele nunca usa.

**Consumidor com o seu próprio caso de uso completo**, duplicando a regra.
Descartada por contrariar a seção 10 diretamente, e porque duas
implementações de uma regra financeira divergem — a questão é quando.

**Confiar na deduplicação do SQS FIFO em vez do inbox.** Descartada pela
restrição 3 do enunciado, e porque a janela de deduplicação do broker é de
cinco minutos: uma reentrega depois disso passaria. O broker é otimização; a
garantia é o banco.

**Processar o lote inteiro em paralelo.** Descartada: destrói a ordenação por
grupo que a fila FIFO acabou de garantir e cria contenção de lock entre
operações da mesma wallet, que é exatamente o que o `MessageGroupId` existe
para evitar.

## Revisitar quando

- Entrar um segundo transporte de entrada. Aí a classificação de erro merece
  sair do adapter de SQS para um lugar compartilhado.
- O consumidor precisar de escala independente da API. A costura está no
  `WorkersModule` e no entrypoint `src/worker.ts`.
- Mensagem para wallet inexistente passar a ser caso real de operação, e não
  erro de integração. Aí a nota em Consequências Neutras vira requisito, e o
  tratamento se parece com o da seção 7.1.
- O pior caso de processamento se aproximar do `VisibilityTimeout` de 30 s.
  Nesse ponto o consumidor precisa renovar a visibilidade enquanto trabalha,
  em vez de só devolvê-la no shutdown.
