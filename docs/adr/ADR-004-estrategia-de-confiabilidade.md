# ADR-004 — Estratégia de confiabilidade e processamento de mensagens

- **Status:** Aceito e implementado
- **Data:** 2026-10-29 (status revisado em 2026-10-30)
- **Decidido por:** Patrick Oliveira

> **Os cinco mecanismos estão em execução.** O que antes
> existia só como schema e repositório — o índice único de idempotência com
> inserção isolada em savepoint, a chave primária composta do inbox, a outbox
> com `for update skip locked`, a taxonomia de códigos de falha e a fila de
> `PENDING_REFERENCE` com o seu índice parcial — agora tem quem o orquestre:
>
> - o **consumidor** da fila, com o inbox no mesmo commit do efeito e `ack`
>   somente depois dele — [ADR-011](ADR-011-consumidor-sqs-e-inbox-transacional.md);
> - o **publicador da outbox**, com vários publicadores concorrentes e fila de
>   saída própria — [ADR-012](ADR-012-fila-de-saida-de-eventos.md);
> - o **worker de referência pendente**, executando a agenda de 8 tentativas
>   em 24 horas definida abaixo —
>   [ADR-013](ADR-013-modelo-de-execucao-dos-workers.md).
>
> A sequência "commit e só então ack", o backoff e o esgotamento da agenda
> deixaram de ser decisão no papel e passaram a ter teste de integração e de
> concorrência contra PostgreSQL e MiniStack reais. Ver
> [ADR-015](ADR-015-execucao-multi-instancia-e-testes-de-concorrencia.md) para
> os oito cenários da seção 13.
>
> Este ADR foi escrito antes do schema de propósito: a restrição 9 manda as
> garantias viverem em constraints, e constraint é o que mais custa mudar
> depois.

## Contexto

A entrega é **at-least-once**. A seção 3 do enunciado lista exatamente o que
se deve assumir: a mesma operação chega várias vezes; uma operação dependente
chega antes da referenciada; várias instâncias tocam a mesma wallet ao mesmo
tempo; o processo morre antes ou depois do commit; eventos são publicados mais
de uma vez; PostgreSQL e SQS ficam temporariamente indisponíveis.

Contra isso pesam quatro invariantes globais que não abrem exceção: não
duplicar crédito, não duplicar débito, não perder evento confirmado, não
permitir saldo negativo.

As restrições invioláveis fecham as saídas fáceis. Nada de cache em memória
para idempotência (2). Nada de confiar em FIFO (3). Nada de publicar antes do
commit (4). Nada de lock global (6). Nada de `read → calculate → update` (7).
E tudo precisa funcionar com múltiplas instâncias (8).

Lidas em conjunto, essas restrições apontam todas para o mesmo lugar: **quem
arbitra é o PostgreSQL**. O resto é otimização.

## Decisão

Cinco mecanismos, cada um cobrindo uma falha específica.

### 1. Idempotência por constraint, não por verificação

A chave de idempotência é `{providerId}:{externalTransactionId}`, acompanhada
de um `payloadHash` SHA-256 sobre o JSON canônico dos campos de negócio.

Quem garante é um **índice único** em `idempotency_key` — e não um "consultar
antes de inserir", que seria `read → calculate → update` com outro nome, e que
duas instâncias atravessam ao mesmo tempo sem nem perceber. O caminho é
inserir direto e tratar a violação de unicidade como fluxo normal: busca a
transação que já existe, compara o hash e devolve replay ou conflito.

Quem decide quem chegou primeiro é o banco. Com N instâncias e nenhuma
coordenação entre elas, não há outro jeito que funcione.

### 2. Inbox para redelivery

Deduplicação persistente por `(consumerName, messageId)`, numa chave primária
composta, gravada **na mesma transação** do efeito financeiro.

O `consumerName` entra na chave porque consumidores diferentes podem vir a
precisar processar a mesma mensagem de forma independente. Deduplicar só por
`messageId` fecharia essa porta à toa.

O **ack sai depois do commit**, e a ordem importa:

1. recebe a mensagem;
2. abre a transação;
3. grava inbox, transação, saldo, ledger e outbox;
4. commit;
5. ack.

Morrendo entre 4 e 5, a mensagem reaparece e o inbox a reconhece como já
processada. Morrendo entre 2 e 4, nada foi gravado e o reprocessamento começa
limpo. Como efeito e registro de idempotência entram no mesmo commit, não
existe janela em que um esteja lá sem o outro.

### 3. Outbox para a publicação de eventos

O evento é **gravado** na transação financeira e **publicado** depois, por um
worker. Assim a restrição 4 é atendida sem ninguém precisar inventar transação
distribuída.

O cenário que a seção 11 exige — commit confirmado, processo morre antes de
publicar, outra instância assume — se resolve sozinho, porque o evento já está
no banco e qualquer publisher o encontra pendente.

Vários publishers concorrentes se coordenam por
`SELECT ... FOR UPDATE SKIP LOCKED`: cada um pega o que o outro não pegou, de
modo que dois workers nunca disputam o mesmo evento nem ficam se bloqueando. É
o padrão certo para fila em tabela, e escapa tanto do lock global que a
restrição 6 proíbe quanto da serialização que um lock ingênuo provocaria.

Publicação duplicada continua possível — o worker pode publicar e morrer antes
de marcar o evento como publicado. Isso é aceito de propósito: o consumidor é
idempotente, e o enunciado pede justamente que "uma publicação duplicada
continua segura para o consumidor".

### 4. Classificação de erro

Três categorias, cada uma com seu tratamento:

| Categoria   | Exemplo                                 | Tratamento                                  |
| ----------- | --------------------------------------- | ------------------------------------------- |
| Negócio     | saldo insuficiente, referência inválida | terminal: persiste `REJECTED` e faz **ack** |
| Transitório | PostgreSQL indisponível, timeout        | **não** faz ack; retry com backoff          |
| Permanente  | payload irrecuperável                   | vai para a **DLQ**                          |

A primeira é a que mais importa: **uma rejeição de negócio é um processamento
bem-sucedido**. A operação foi avaliada e recusada, e isso é resultado, não
falha. Dar nack nela devolveria a mensagem para a fila só para ser rejeitada
de novo, cinco vezes seguidas, até cair na DLQ — enchendo a DLQ de coisa que
deveria estar no ledger de auditoria.

O `maxReceiveCount` é **5**: alto o bastante para aguentar uma queda curta do
banco, baixo o bastante para tirar depressa uma mensagem venenosa do caminho.

### 5. Referências fora de ordem

`REFUND` e `ROLLBACK` podem chegar antes da operação que referenciam. Quando
isso acontece, a transação é gravada como `PENDING_REFERENCE` e volta a ser
processada por um worker agendado com backoff exponencial, em **8 tentativas
ao longo de 24 horas**.

Vinte e quatro horas dão conta de um atraso operacional de um dia inteiro do
provedor, fim de semana parcial incluído, sem deixar a transação pendurada
para sempre. Esgotado o limite, ela vira `REJECTED` com
`REFERENCE_NOT_FOUND`, e o evento correspondente é publicado para que o
provedor fique sabendo.

Rejeitar logo na primeira tentativa foi descartado: com entrega at-least-once
e sem ordem garantida, referência ausente é situação esperada, não exceção.

## Consequências

**Positivas**

- Todas as garantias ficam em lugares que funcionam com N instâncias:
  constraints, locks de linha e transações. Nenhuma depende de estado em
  memória.
- O crash entre commit e ack, que é o caso mais difícil de acertar, se resolve
  pela própria estrutura, sem precisar de compensação depois.
- O `SKIP LOCKED` dá paralelismo de verdade entre publishers, sem lock global.
- Separar erro de negócio de erro de infraestrutura mantém a DLQ como sinal
  útil: o que está lá dentro realmente precisa de alguém olhando.

**Negativas**

- São cinco escritas por operação, em quatro tabelas, dentro de uma
  transação. Isso custa, e o custo aparece sob carga.
- A outbox é uma tabela que só cresce e vai precisar de expurgo; sem isso, o
  índice de pendentes degrada.
- Aceitar publicação duplicada joga a responsabilidade pela idempotência para
  quem consome os eventos.
- O lock pessimista põe em fila as operações de uma mesma wallet. Numa wallet
  muito movimentada, isso se nota.
- O worker de `PENDING_REFERENCE` cria uma segunda fonte de escrita sobre as
  mesmas transações, e precisa do mesmo cuidado com concorrência que a entrada
  principal.

**Neutras**

- FIFO e `MessageGroupId` por wallet continuam úteis como otimização: reduzem
  contenção no lock e diminuem a frequência de operações fora de ordem. Mas
  nada de correto se apoia neles — e é por isso que o `maxReceiveCount` e o
  inbox existem.

## Alternativas consideradas

**Verificar se já existe antes de inserir, em vez de depender da constraint.**
Descartado. É `read → calculate → update`, que a restrição 7 proíbe, e com
duas instâncias simultâneas ele falha em silêncio — o pior modo de falha que
um sistema financeiro pode ter.

**Publicar o evento dentro da transação, direto no SQS.** Descartado pela
restrição 4, e haveria motivo mesmo sem ela: se a publicação der certo e o
commit falhar, acabou de ser anunciado um fato que não aconteceu. Mensagem
publicada não tem rollback.

**Two-phase commit entre PostgreSQL e SQS.** Descartado. O SQS não participa
de 2PC e, mesmo que participasse, o acoplamento e a indisponibilidade diante
de uma falha do coordenador sairiam mais caros que o problema original.

**Lock otimista por `version` com retry, no lugar do pessimista.** Descartado
como estratégia principal, mas mantido como campo de auditoria. No cenário
obrigatório da seção 8 — duas apostas disputando a mesma wallet — o otimista
vira cascata de retries bem na hora em que o sistema está sob pressão. A
`version` continua sendo mantida e incrementada, porque é informação de
auditoria barata e ajuda a detectar divergência na reconciliação.

**Confiar na deduplicação do SQS FIFO como garantia de idempotência.**
Descartado pela restrição 3, e tecnicamente insustentável: a janela de
deduplicação do SQS dura cinco minutos, e uma reentrega legítima fora dela
duplicaria o efeito financeiro.

**Rejeitar na hora toda operação com referência ausente.** Descartado. Com
entrega at-least-once e sem ordem garantida, isso recusaria operações válidas
por puro acidente de temporização.

## Revisitar quando

- A medição mostrar que o lock pessimista virou gargalo sob carga realista, o
  que só dá para saber depois do teste de carga opcional.
- O volume da outbox exigir particionamento ou expurgo automático.
- A quantidade de `PENDING_REFERENCE` esgotando as 8 tentativas indicar que 24
  horas é pouco para o comportamento real dos provedores.
- Algum provedor passar a exigir reversão parcial, hoje fora de escopo.
