# ADR-009 — Prazos explícitos: timeout é indisponibilidade

- **Status:** Aceito e implementado
- **Data:** 2026-10-29 (status revisado em 2026-10-30)
- **Decidido por:** Patrick Oliveira

## Contexto

A seção 3 do enunciado manda assumir que "PostgreSQL e SQS ficam
temporariamente indisponíveis". Indisponibilidade tem duas formas, e elas se
comportam de modo muito diferente:

- **Recusa.** A conexão não abre. Falha rápido por conta própria, com
  `ECONNREFUSED`.
- **Silêncio.** A conexão abre, a requisição é aceita e a resposta nunca vem.
  Não falha por conta própria **nunca**.

A segunda é a que importa decidir, e o estado anterior do código não a tratava:

1. `createSqsClient` não configurava prazo nenhum. O default do handler HTTP do
   SDK é `requestTimeout: 0`, isto é, sem limite.
2. `SqsHealthIndicator` e `PostgresHealthIndicator` não tinham prazo próprio.
   Com um cliente sem limite, `GET /health/ready` **nunca respondia**.

O item 2 é o grave, e é grave por um motivo específico: o próprio comentário do
`HealthController` diz que liveness e readiness são separados para que "um
orquestrador consiga distinguir um processo quebrado de uma dependência fora do
ar". Um readiness que não responde é indistinguível de um processo quebrado. A
separação existia e não entregava o que prometia.

Há ainda um detalhe do SDK que torna a configuração ingênua pior que inútil:
mesmo com `requestTimeout` configurado, o `@smithy/node-http-handler` por
padrão **apenas emite um aviso** ao estourá-lo e deixa a requisição seguir
esperando.

```
[WARN] a request has exceeded the configured 1000 ms requestTimeout.
Init client requestHandler with throwOnRequestTimeout=true to turn this into an error.
```

Medido contra um endpoint que aceita e não responde: com o prazo configurado e
sem a flag, 6 segundos depois a chamada ainda não havia terminado. O número
estava no código, o aviso estava no log, e nada terminava.

## Decisão

Prazo explícito em toda E/S, e indisponibilidade sempre vira resposta — nunca
exceção que sobe, nunca espera sem fim.

### Transporte: teto da operação legítima mais lenta

O cliente SQS recebe `connectionTimeout`, `requestTimeout` e
`throwOnRequestTimeout: true`, vindos do ambiente.

`requestTimeout` é generoso de propósito: a operação legítima mais lenta é um
`ReceiveMessage` com long poll de até 20 segundos, e um prazo de transporte
**menor** que o long poll abortaria todo recebimento normal. O sintoma seria
um consumidor que nunca recebe nada e não acusa erro — falha difícil de
diagnosticar e trivial de impedir. Então a inicialização recusa qualquer valor
abaixo do long poll mais margem, pelo mesmo mecanismo que já recusa fila sem
sufixo `.fifo`.

### Chamador: prazo por requisição

Quem não pode esperar o teto do transporte impõe o seu, por requisição, com
`AbortSignal`. É o caso do readiness: ele responde sobre o estado atual, e
esperar 20 segundos numa sonda deixaria o orquestrador sem resposta justamente
quando ele precisa decidir se tira a instância do balanceador.

### Readiness: duas barreiras com papéis distintos

- `AbortSignal.timeout(prazo)` **cancela** a requisição HTTP, liberando o
  socket.
- `withDeadline(..., prazo + folga)` **garante** que a função responda, mesmo
  que o sinal seja ignorado.

A segunda existe porque a promessa feita ao orquestrador — readiness sempre
responde — não deve depender de uma biblioteca honrar um cancelamento. A folga
faz o cancelamento vencer a corrida no caminho normal, de modo que o erro
registrado seja o mais informativo dos dois.

### Indisponibilidade é resultado, não exceção

Os indicadores devolvem `down` com o motivo. Se levantassem, o terminus
responderia 500 em vez de 503, e a distinção entre "dependência fora do ar" e
"aplicação quebrada" se perderia de novo, por outro caminho.

## Verificação

Medido em 2026-10-30, contra serviços reais e contra um socket real.

| Cenário                                                 | Antes                   | Depois                                         |
| ------------------------------------------------------- | ----------------------- | ---------------------------------------------- |
| SQS recusando conexão, `GET /health/ready`              | 503 (já funcionava)     | **503 em 0,39 s**, com `ECONNREFUSED`          |
| SQS calado, `GET /health/ready`                         | **nunca respondia**     | **503 em 2,02 s**, `AbortError … TimeoutError` |
| `GetQueueUrl` contra endpoint calado, sem `AbortSignal` | pendurado a 6 s+        | `TimeoutError` em 2,5 s (prazo × 3 tentativas) |
| `GetQueueUrl` contra endpoint calado, com `AbortSignal` | —                       | `AbortError` em 0,40 s                         |
| Spec de SQS com o container acabando de subir           | `hook timed out` em 5 s | **4 passando em 10,6 s**                       |

O endpoint calado é um `Bun.serve` que aceita a conexão e nunca responde:
socket real, SDK real, nenhum dublê. Está em
`test/integration/sqs-unavailability.spec.ts`.

O comportamento dos indicadores sob silêncio é coberto em
`test/unit/health-timeout.spec.ts`, que **usa dublês e os declara** no topo do
arquivo: provar que o readiness responde quando a dependência não responde
exige uma dependência que trave sob demanda, e isso não se pede a um serviço
real de forma determinística.

## Consequências

**Positivas**

- O readiness sempre responde, e com prazo conhecido. A distinção entre 503 e
  500 volta a significar o que o desenho dizia que significava.
- O piso do prazo de transporte é validado na inicialização, então ninguém
  configura um valor que aborta long poll legítimo sem descobrir na hora.
- A aplicação sobe com as dependências fora do ar — já era verdade por causa
  do `connect: false` e da construção lazy do cliente, e agora tem teste.
- `throwOnRequestTimeout` fica registrado. É o tipo de default que se descobre
  em produção às três da manhã.

**Negativas**

- Três variáveis novas no contrato de ambiente. Têm default, então o `.env`
  existente continua valendo, mas o contrato cresceu.
- `withDeadline` **não cancela** a operação: a consulta do readiness ao
  PostgreSQL segue no servidor até terminar. Para um `select 1` é irrelevante,
  e para qualquer coisa maior não seria — a função não serve como mecanismo
  geral de cancelamento.
- Duas barreiras no readiness é mais mecanismo para entender do que uma.
- O prazo do readiness precisa ficar abaixo do prazo que o orquestrador dá à
  sonda, que é um número que não vive neste repositório. O acoplamento está
  documentado no `.env.example` e não é verificável aqui.
- O padrão "quem precisa de prazo curto passa `AbortSignal`" depende de quem
  escrever o próximo chamador lembrar disso. Nada no tipo obriga.

**Neutras**

- Com `SQS_MAX_ATTEMPTS` em 3, o prazo de transporte se multiplica por até
  três: 800 ms de prazo deram 2,5 s de espera total na medição. É o custo do
  backoff do SDK, e quem precisa de limite apertado usa `AbortSignal`, que
  corta antes das retentativas.

## Alternativas consideradas

**Confiar nos defaults do SDK.** Era o estado anterior, e é o defeito: sem
limite de requisição, e com limite configurado o estouro é só um aviso.

**Só o `AbortSignal`, sem prazo de transporte.** Descartada. Funcionaria para
quem lembrasse de passar o sinal, e qualquer chamador que esquecesse herdaria a
espera infinita. O prazo de transporte é o piso que vale para todos.

**Só o prazo de transporte, sem `AbortSignal` por chamada.** Descartada. O
readiness herdaria o teto do long poll — 20 segundos para responder a uma
sonda —, o que é o mesmo problema com outro número.

**Só `withDeadline`, sem cancelamento.** Descartada. A função responderia, mas
o socket ficaria aberto e a requisição seguiria consumindo recurso. Sob uma
indisponibilidade prolongada, uma sonda a cada poucos segundos acumularia
requisições penduradas.

**Timeout global no servidor HTTP, por interceptor do Nest.** Descartada. A
resposta sairia, e o trabalho continuaria pendurado atrás dela. E não ajudaria
em nada o consumidor da fila nem os workers, que não atendem HTTP — o problema
não é da camada HTTP.

**Circuit breaker na frente das dependências.** Descartada por ora. Resolve um
problema diferente — parar de bater numa dependência que já se sabe fora —, e
acrescenta estado e um modo de falha próprio (abrir o circuito por engano).
Sem medição que mostre a necessidade, é complexidade adiantada.

## Revisitar quando

- A duração do long poll do consumidor mudar, porque o piso do prazo de
  transporte é derivado dela.
- O orçamento da sonda do orquestrador obrigar a um prazo de readiness
  diferente do default de 2 s.
- A frequência de timeouts em produção justificar circuit breaker — o sinal
  seria a métrica de erro de transporte, que entra junto com a observabilidade.
- Alguma operação legítima passar a ser mais lenta que o long poll, caso em que
  o teto deixa de ser derivado dele.
