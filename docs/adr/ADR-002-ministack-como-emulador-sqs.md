# ADR-002 — MiniStack como emulador de SQS local

- **Status:** Aceito, confirmado por teste em 2026-10-29
- **Data:** 2026-10-29
- **Decidido por:** Patrick Oliveira

> **Confirmada na prática.** As quatro capacidades de que esta decisão depende
> — fila FIFO com `RedrivePolicy`, entrega com `MessageGroupId`, deduplicação
> por `MessageDeduplicationId` e redrive para DLQ ao esgotar
> `maxReceiveCount` — foram exercitadas contra o MiniStack 1.5.33 e passaram.
> Ver [Verificação](#verificação).

## Contexto

O enunciado fixa **AWS SQS** como mensageria e aceita duas formas de rodá-lo
localmente: "**LocalStack** ou **MiniStack**". Quem escolhe é o candidato.

O projeto não pede pouco do emulador:

- filas **FIFO** — os nomes `wager-transactions.fifo` e
  `wager-transactions-dlq.fifo` aparecem literais na seção 10;
- `MessageGroupId`, para que operações da mesma wallet não se embaralhem;
- `MessageDeduplicationId`, com deduplicação feita pelo broker;
- **dead-letter queue** com `RedrivePolicy` e `maxReceiveCount`;
- visibility timeout respeitado, já que o ack só sai depois do commit.

Em março de 2026 o LocalStack mudou de modelo. A edição Community foi
descontinuada no dia 23; a imagem `latest` passou a exigir token de
autenticação; e o plano gratuito **Hobby** exige conta e, nos próprios termos
dele, **proíbe uso comercial**. Hoje a documentação de SQS do LocalStack
descreve o serviço como disponível "a partir do plano Hobby".

Isso pesa por um motivo bem concreto: alguém vai clonar este repositório e
rodá-lo para avaliar. Pedir cadastro entre o `git clone` e o
`docker compose up` cria um atrito que nada tem a ver com o que está sendo
avaliado.

## Decisão

**MiniStack 1.5.33**, com a versão fixada no `docker-compose.yml`.

A escolha fica isolada atrás de uma variável de ambiente só. O cliente SQS
sobrescreve o endpoint apenas quando `SQS_ENDPOINT` tem algum valor; vazio
significa AWS de verdade. Nenhum outro ponto do código sabe que existe um
emulador, e muito menos qual deles.

```ts
return new SQSClient({
  region: config.region,
  credentials: { accessKeyId, secretAccessKey },
  ...(config.endpoint === '' ? {} : { endpoint: config.endpoint }),
});
```

Trocar de emulador, ou apontar para a AWS real, é editar o `.env`.

A topologia das filas fica declarada num módulo só,
`src/infrastructure/messaging/queue-topology.ts`, que o script de bootstrap,
os health checks e os testes consomem. Se quem cria a fila e quem a consome
discordarem de um atributo, o erro só vai aparecer sob carga — e é exatamente
esse tipo de surpresa que a declaração única evita.

## Consequências

**Positivas**

- Licença MIT, sem conta, sem token e sem telemetria. `git clone` e
  `docker compose up` bastam.
- Não há restrição de uso comercial para pesar.
- Mesma porta e mesmo protocolo do LocalStack (`:4566`), então a escolha não
  vaza para o código da aplicação, só para o `.env`.
- Imagem de cerca de 65 MB contra aproximadamente 1 GB, o que encurta bastante
  o primeiro `docker compose up` de quem avalia.

**Negativas**

- **O projeto é bem menos maduro.** Quem descreve a cobertura de SQS é o
  próprio MiniStack, sem verificação independente publicada. A documentação
  menciona FIFO com deduplicação e DLQ, mas **não explica como configurar a
  `RedrivePolicy`**, e trata `MessageGroupId` e `MessageDeduplicationId` só de
  forma implícita. Os atributos certos saíram de teste, não de documentação.
  As quatro capacidades passaram (ver [Verificação](#verificação)), mas o que
  foi testado é a superfície que este projeto usa, e nada além dela.
- O ritmo de lançamento é alto: três versões em menos de duas semanas, sinal
  de que a superfície ainda se mexe. Daí a versão fixada em vez de `latest`.
- Comportamentos de borda do SQS real — janela de deduplicação de cinco
  minutos, ordenação estrita por grupo sob contenção — podem divergir, e um
  teste que passa localmente não diz nada sobre o que acontece na AWS.

**Neutras**

- A própria arquitetura limita o risco dessa divergência. A restrição 3 do
  enunciado já proíbe confiar em FIFO para garantir corretude: FIFO e
  deduplicação do broker são otimização, e quem garante é o inbox persistente
  no PostgreSQL. Um emulador que erre a deduplicação gera trabalho duplicado,
  não resultado financeiro errado.

## Alternativas consideradas

**LocalStack na imagem atual.** Descartado. Exige conta e token, e o plano
gratuito proíbe uso comercial — um desafio técnico de processo seletivo
acabaria numa zona cinzenta sem necessidade. Tecnicamente, seria a opção mais
segura: SQS maduro, FIFO e DLQ documentados em detalhe, 23 de 23 operações
implementadas.

**LocalStack fixado numa versão anterior ao fim da Community** (`4.14.0` ou
mais antiga). Descartado como escolha principal, mas mantido como plano de
contingência. Funciona e dispensa conta, só que congela o projeto numa versão
sem correção de segurança e apoia tudo em algo que o mantenedor encerrou de
forma explícita — difícil de defender numa conversa sobre decisões técnicas.

**ElasticMQ.** Descartado. Implementa SQS, é open source e suporta FIFO, mas é
um servidor de SQS isolado, não um emulador de AWS: se o projeto precisar de
outro serviço mais adiante, vira mais uma peça para manter. Fora que o
enunciado nomeia LocalStack e MiniStack, e sair dessa lista exigiria
justificativa mais forte do que a que existe.

**SQS real numa conta AWS.** Descartado. Vai contra o "orquestração local:
Docker Compose" do enunciado, exige credenciais que não podem ser versionadas,
e deixa os testes dependentes de rede e sujeitos a custo.

## Verificação

Rodada em 2026-10-29 contra `ministackorg/ministack:1.5.33`, via
`bun run test:integration`. Não há mock em lugar nenhum: as asserções recaem
sobre respostas reais do emulador.

| Teste em `test/integration/sqs-fifo-dlq.spec.ts` | O que confirma                  | Resultado        |
| ------------------------------------------------ | ------------------------------- | ---------------- |
| cria a fila como FIFO e com `RedrivePolicy`      | atributos aceitos e persistidos | passou (4 ms)    |
| entrega, devolve e apaga com `MessageGroupId`    | ciclo básico FIFO               | passou (1015 ms) |
| deduplica por `MessageDeduplicationId`           | deduplicação do broker          | passou (2017 ms) |
| move para a DLQ ao esgotar `maxReceiveCount`     | redrive funcional               | passou (5026 ms) |

O `bun run infra:check` lê de volta os atributos da fila criada pelo script de
bootstrap e confirma:

```
FIFO=true redrive={"deadLetterTargetArn":"arn:aws:sqs:us-east-1:000000000000:wager-transactions-dlq.fifo","maxReceiveCount":5}
```

**O que a verificação não cobre.** Os testes mostram que o emulador implementa
essas quatro capacidades, não que ele seja equivalente ao SQS da AWS. A janela
de deduplicação de cinco minutos e a ordenação estrita por grupo sob contenção
real ficaram de fora: o teste de deduplicação roda em segundos, e o de DLQ usa
visibility timeout de 1 segundo para terminar rápido. Divergência nessas
bordas segue sendo possível.

## Gatilho de reversão

A decisão volta a ficar em aberto se algum dos testes acima passar a falhar,
ou se uma das bordas não cobertas — janela de deduplicação, ordenação sob
contenção — divergir do SQS real a ponto de afetar o desenho.

Nesse caso: trocar para `localstack/localstack:4.14.0` no
`docker-compose.yml`, anotar aqui qual capacidade faltou, e explicar no README
que a imagem está congelada e por quê. O código da aplicação não muda, só o
`.env` e o Compose — que é justamente por isso que a decisão vive isolada
atrás de uma variável.

## Revisitar quando

- O consumidor real entrar em operação e exercitar a janela de deduplicação de
  cinco minutos ou a ordenação sob contenção, que são as bordas que os testes
  atuais deixam de fora.
- O MiniStack publicar uma versão que mude o comportamento de FIFO ou de DLQ.
- O LocalStack voltar a oferecer uma edição livre, sem restrição de uso.
- O projeto precisar de um serviço AWS que o MiniStack não cubra.
