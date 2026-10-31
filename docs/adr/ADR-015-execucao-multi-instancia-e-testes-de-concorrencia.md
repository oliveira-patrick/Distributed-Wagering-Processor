# ADR-015 — Execução multi-instância e estratégia dos testes de concorrência

- **Status:** Aceito e implementado
- **Data:** 2026-10-30
- **Decidido por:** Patrick Oliveira

## Contexto

A seção 8 do enunciado exige que a solução permaneça correta com **três ou
mais instâncias** rodando ao mesmo tempo, e a restrição 8 trata "solução
correta somente com uma instância" como falha eliminatória.

A seção 13 cobra oito cenários com **paralelismo real**, e é explícita sobre o
que não serve: "não mocks sequenciais".

Antes desta decisão o `docker-compose.yml` subia PostgreSQL e MiniStack, não a
aplicação. Não havia como pôr três instâncias de pé, e nenhum teste de
concorrência existia.

Duas perguntas a decidir, e elas têm respostas diferentes:

- como **demonstrar** três instâncias para quem vai avaliar?
- como **testar** concorrência de forma repetível?

## Decisão

As duas coisas, por caminhos diferentes — porque o que cada uma precisa é
diferente.

### Demonstração: Dockerfile e perfil `app` no Compose

Um `Dockerfile` multi-stage sobre `oven/bun:1.4.4-alpine`, versão fixada como
as de PostgreSQL e MiniStack. Sem etapa de build: o Bun executa TypeScript
direto, e emitir JavaScript acrescentaria um artefato intermediário sem
resolver nada. O `tsc` continua rodando como verificação de tipos em
`bun run check`.

No Compose, três serviços sob o perfil `app`:

- **`bootstrap`** — um disparo só: migrations e criação das filas;
- **`api`** — escalável, publicada num **intervalo** de portas;
- **`worker`** — o processo de trabalho de fundo.

```bash
docker compose --profile app up -d --build --scale api=3
```

O perfil existe para que `bun run infra:up` continue subindo só a
infraestrutura, que é o que o desenvolvimento pede.

**Por que `bootstrap` é um serviço próprio.** É a única forma de o Compose
garantir ordem de verdade — `service_completed_successfully`. Deixar cada
réplica aplicar migrations na subida poria três delas disputando a tabela de
controle do migrator.

**Por que um intervalo de portas** (`3000-3002:3000`). Porta única falha na
segunda réplica. Com intervalo, o Compose distribui uma porta para cada uma, e
o teste de três instâncias tem três endereços para usar.

O healthcheck usa `bun -e` com `fetch`, não `curl`: a imagem alpine não traz
curl, e o Bun está garantidamente lá.

### Teste: processos filhos, não contêineres

Os testes de concorrência sobem processos `bun src/main.ts` e
`bun src/worker.ts` de verdade, com `Bun.spawn`, apontados para o banco e as
filas descartáveis da suíte por variáveis de ambiente.

**Por que não os contêineres.** Um `docker build` por alteração de código
tornaria a suíte lenta demais para ser executada com frequência — e é a
frequência que faz um teste de concorrência valer algo. Um teste que ninguém
roda não protege nada.

**Por que não `Promise.all` num processo só.** Um processo compartilha o pool
de conexões, o event loop e a memória, e nenhum dos três é compartilhado entre
instâncias de verdade. Testar assim provaria que o código é reentrante, não
que a solução é correta com múltiplas instâncias — que é o que o enunciado
exige e o que a restrição 8 trata como eliminatório.

As duas formas rodam **a mesma aplicação**, com a mesma composição. A imagem
não está no caminho do teste; está no caminho da demonstração.

### Três regras que toda suíte de concorrência segue

**1. Barreira explícita na partida.** As requisições são montadas, esperam um
mesmo `gate`, e só então saem — todas no mesmo tick do event loop. Com
`sleep` para "sincronizar", o primeiro trabalho terminaria antes de o último
ser criado, e o teste mediria uma fila em vez de uma disputa.

**2. A asserção é sobre o estado final, nunca sobre quem venceu.** "Uma
aposta `PROCESSED` e uma `REJECTED`" é determinístico; "a primeira requisição
vence" não é, e um teste que afirme isso vai falhar por motivo nenhum.

**3. Cada cenário começa limpo.** Um `afterEach` encerra os processos
filhos. Sem isso, os workers de um cenário sobrevivem para o seguinte — e como
todo worker traz o seu publicador de outbox, o cenário de dois publicadores
passava a ter quatro, com os dois novos encontrando a fila já drenada pelos
antigos. Falhava de forma intermitente, e a causa não estava em lugar nenhum
perto da asserção.

### Um processo por arquivo de teste

O `scripts/run-suite.ts` roda cada arquivo `.spec.ts` no seu próprio processo,
sequencialmente, e serve tanto à suíte de integração quanto à de concorrência.

A razão é mecânica: cada suíte aponta para o seu banco e as suas filas
ajustando `process.env` **antes** de importar `ConfigModule`, e o
`NestConfigModule.forRoot` é avaliado no import — que é cacheado pelo
processo. Num processo compartilhado, o segundo arquivo recebe o
`ConfigModule` do primeiro, amarrado ao banco e às filas dele.

O sintoma era enganoso e vale registrar: cada arquivo passava sozinho e a
suíte inteira falhava por timeout, porque os workers do segundo arquivo
estavam operando no banco do primeiro. Não era lentidão, era alvo errado.

Sequencial, e não em paralelo: os arquivos criam e derrubam bancos no mesmo
PostgreSQL. E os testes de concorrência medem contenção — dois arquivos
disputando a mesma máquina mediriam a disputa entre eles.

### Como o cenário "morte entre o commit e o ack" é construído

Matar um processo exatamente nesse instante não se consegue por cronometragem.
O cenário é construído, e cada passo usa infraestrutura real:

1. a mensagem é publicada na fila;
2. o teste a **recebe** com o cliente do SDK — ela fica em voo, invisível para
   os outros consumidores — e a processa chamando o caso de uso de consumo em
   processo, que comita;
3. o teste **não** apaga a mensagem. Esse é exatamente o estado que um worker
   morto entre o commit e o `ack` deixa para trás;
4. o `VisibilityTimeout` expira e a mensagem reaparece;
5. um worker de verdade sobe, a recebe, e precisa não duplicar nada.

O que se substitui não é PostgreSQL nem SQS nem o caso de uso: é só quem
deixou de chamar `DeleteMessage` — e é essa ausência que o cenário existe para
reproduzir.

## Verificação

`bun run test:concurrency`, 11 casos em 2 arquivos, contra PostgreSQL 17.6 e
MiniStack reais, com processos de verdade. Os oito cenários da seção 13:

| Cenário da seção 13                  | Onde                 |
| ------------------------------------ | -------------------- |
| 1 — mesma aposta 50× em paralelo     | `hot-wallet.spec.ts` |
| 2 — disputa pelo saldo (seção 8)     | `hot-wallet.spec.ts` |
| 3 — wallets distintas em paralelo    | `hot-wallet.spec.ts` |
| 4 — três instâncias simultâneas      | `hot-wallet.spec.ts` |
| 5 — worker morto entre commit e ack  | `recovery.spec.ts`   |
| 6 — dois publicadores sobre a outbox | `recovery.spec.ts`   |
| 7 — reversão antes da referência     | `recovery.spec.ts`   |
| 8 — reinício com consistência final  | `recovery.spec.ts`   |

Todos terminam com a invariante final da seção 13:
`wallet.balance == saldo reconstruído pelo ledger`, conferida em SQL cru.

A demonstração em contêiner foi executada: `--scale api=3` sobe três réplicas
`healthy` em 3000, 3001 e 3002, mais o worker. Uma wallet criada na primeira
réplica, uma aposta aplicada na segunda e o **replay da mesma
`Idempotency-Key` na terceira** devolveram o mesmo `transactionId` com
`idempotentReplay: true` — que é a prova de que a idempotência é persistente e
atravessa instâncias, não um cache de processo.

## Consequências

**Positivas**

- Os oito cenários da seção 13 são executáveis com um comando, em segundos, e
  passaram em execuções repetidas.
- A suíte de concorrência não depende de build de imagem, então é rápida o
  bastante para rodar com frequência.
- Quem avalia tem um comando para ver três instâncias de pé.
- O `/metrics` por processo serve de prova de que o trabalho se espalhou de
  verdade — não é inferência a partir de tempos.
- Um processo por arquivo eliminou uma classe inteira de interferência entre
  suítes, e falhas passaram a ser atribuíveis.

**Negativas**

- **Dois caminhos de execução para manter.** O Dockerfile e o
  `spawnInstance` podem divergir: uma variável de ambiente nova precisa ser
  acrescentada nos dois, e só o Compose falharia de forma óbvia.
- A suíte de concorrência **exige infraestrutura no ar** e não tem como ser
  executada sem Docker. Isso é inevitável dado o enunciado, e ainda assim é
  uma barreira a mais para quem só quer rodar os testes.
- Um processo por arquivo torna a suíte mais lenta: cada arquivo paga a
  inicialização do Bun, do Nest e das migrations. A integração passou de ~37 s
  para ~90 s.
- Os testes de concorrência são, por natureza, mais sensíveis à máquina que os
  outros. As três regras acima reduzem isso, mas não a zero — e duas falhas
  intermitentes já apareceram e foram corrigidas durante o desenvolvimento,
  ambas por defeito do teste e não do sistema.
- `Bun.spawn` com `stdout: 'pipe'` acumula a saída dos processos filhos em
  memória até o fim do teste. Com volume alto de log, isso cresce; o
  `LOG_LEVEL: 'warn'` nas instâncias de teste é o que mantém o volume baixo.

**Neutras**

- A porta livre é descoberta abrindo e fechando um servidor na porta 0. Há uma
  janela entre fechar e a instância abrir; a alternativa — numerar a partir de
  uma base — colide quando duas execuções da suíte se cruzam, o que é mais
  confuso de diagnosticar que um `EADDRINUSE` imediato.
- A cadeia do ledger é verificada de forma **independente de ordem**:
  partindo de zero, procura-se o lançamento cujo `balance_before` é o saldo
  atual, consome-se, e repete. Sob concorrência, vários lançamentos caem no
  mesmo instante e `order by created_at, id` não recupera a sequência — o
  `id` é um UUID aleatório. Ordenar e comparar vizinhos reprovava um ledger
  correto, e esta forma é mais forte: ela prova que existe um caminho contínuo
  que usa todos os lançamentos.
- `docker compose --profile app down` derruba **também** a infraestrutura. Vale
  saber: `docker compose down` sem o perfil faz o mesmo, e o volume do
  PostgreSQL é nomeado e sobrevive — mas o MiniStack não tem volume, então as
  filas precisam ser recriadas com `bun run queues:bootstrap`.

## Alternativas consideradas

**Só processos filhos, sem Dockerfile.** Descartada por pouco. Os testes
cobririam tudo, e quem avalia não teria um comando único para ver três
instâncias — o que, para um requisito que vale pontos e tem falha eliminatória
associada, é pedir que acreditem no teste sem poder olhar.

**Só Dockerfile e réplicas no Compose, com os testes contra os contêineres.**
Descartada: cada alteração de código exigiria rebuild, e a suíte ficaria lenta
e mais frágil — o build passa a ser parte do caminho de teste.

**`Promise.all` num processo só.** Descartada por contrariar a seção 13
diretamente. Prova reentrância, não corretude multi-instância.

**Três réplicas atrás de um balanceador, com os testes batendo num endereço
só.** Descartada: o teste perderia a capacidade de escolher a instância, e com
ela a possibilidade de afirmar que o replay numa **terceira** réplica devolve
o resultado da primeira — que é a demonstração mais direta de que a
idempotência não é de processo.

**`testcontainers` para orquestrar a infraestrutura por suíte.** Descartada:
seria uma dependência nova para substituir o `docker-compose.yml` que o
enunciado pede de todo modo, e cada suíte pagaria a subida de PostgreSQL e do
emulador em vez de reusar os que já estão no ar.

## Revisitar quando

- Alguma falha intermitente voltar a aparecer. A primeira pergunta é se o
  cenário tem mais de um ator sobre a mesma linha — foi a causa das duas que
  apareceram.
- A suíte de integração crescer até o custo de um processo por arquivo doer.
  Aí vale agrupar arquivos que compartilham a mesma configuração de ambiente
  num processo só.
- Entrar teste de carga no escopo. Aí os contêineres passam a ser o caminho
  certo de execução, porque o que se mede inclui o custo do ambiente.
- A aplicação ganhar configuração que o `spawnInstance` não repasse. O
  sintoma será um teste de concorrência que passa com default errado.
