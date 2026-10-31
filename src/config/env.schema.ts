import { z } from 'zod';

/*
  Teto do long polling do SQS, em segundos — limite da própria AWS para
  `WaitTimeSeconds`.

  Mora aqui porque é o número contra o qual o timeout de requisição precisa
  ser validado: um `ReceiveMessage` com long poll é uma requisição
  legitimamente lenta, e um timeout de transporte menor que o long poll
  abortaria todo recebimento normal. O sintoma seria um consumidor que nunca
  recebe nada e não acusa erro nenhum — falha difícil de diagnosticar e
  trivial de impedir na inicialização.
*/
export const MAX_LONG_POLL_SECONDS = 20;

// Long poll inteiro mais margem para o handshake e a resposta.
const MIN_SQS_REQUEST_TIMEOUT_MS = MAX_LONG_POLL_SECONDS * 1_000 + 5_000;

/*
  Contrato das variáveis de ambiente.

  A validação acontece uma única vez, na inicialização: um ambiente
  incompleto derruba o processo imediatamente, em vez de produzir uma falha
  obscura na primeira conexão com o banco ou com a fila.
*/
export const envSchema = z.object({
  // --------------------------- aplicação -------------------------------
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  APP_PORT: z.coerce.number().int().positive().max(65_535).default(3000),

  /*
    Porta do processo de worker, só para `/health` e `/metrics`.

    Separada da `APP_PORT` porque os dois processos rodam no mesmo host
    durante os testes de concorrência, e porta compartilhada faria o segundo
    a subir morrer com `EADDRINUSE`.
  */
  WORKER_PORT: z.coerce.number().int().positive().max(65_535).default(3001),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),

  // --------------------------- PostgreSQL --------------------------------
  POSTGRES_HOST: z.string().min(1),
  POSTGRES_PORT: z.coerce.number().int().positive().max(65_535),
  POSTGRES_USER: z.string().min(1),
  POSTGRES_PASSWORD: z.string().min(1),
  POSTGRES_DB: z.string().min(1),

  // --------------------------- AWS SQS -----------------------------------
  AWS_REGION: z.string().min(1),
  AWS_ACCESS_KEY_ID: z.string().min(1),
  AWS_SECRET_ACCESS_KEY: z.string().min(1),

  // Vazio significa "use o endpoint padrão do SDK" — isto é, a AWS real.
  SQS_ENDPOINT: z.union([z.url(), z.literal('')]).default(''),

  /*
    As filas precisam ser FIFO. Validar o sufixo aqui transforma um erro de
    configuração silencioso — criar uma fila standard e perder ordenação e
    deduplicação do broker — em falha de inicialização.
  */
  SQS_QUEUE_NAME: z
    .string()
    .regex(/\.fifo$/, 'a fila principal precisa terminar em .fifo'),
  SQS_DLQ_NAME: z.string().regex(/\.fifo$/, 'a DLQ precisa terminar em .fifo'),

  /*
    Fila de **saída** dos eventos de integração, e a DLQ dela.

    Os eventos precisam sair para
    outro lugar, e não para a de entrada, que carrega comandos. Ver ADR-012.
  */
  SQS_EVENTS_QUEUE_NAME: z
    .string()
    .regex(/\.fifo$/, 'a fila de eventos precisa terminar em .fifo'),
  SQS_EVENTS_DLQ_NAME: z
    .string()
    .regex(/\.fifo$/, 'a DLQ de eventos precisa terminar em .fifo'),

  SQS_CONSUMER_NAME: z.string().min(1),

  /*
    Prazo de uma requisição ao SQS. O default do SDK é **sem limite**, o que
    faz um endpoint que aceita a conexão e não responde pendurar a chamada
    para sempre.
  */
  SQS_REQUEST_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(
      MIN_SQS_REQUEST_TIMEOUT_MS,
      `precisa tolerar um long poll de ${String(MAX_LONG_POLL_SECONDS)}s, ` +
        `logo no mínimo ${String(MIN_SQS_REQUEST_TIMEOUT_MS)} ms`,
    )
    .max(300_000)
    .default(30_000),

  // Prazo só para estabelecer a conexão — bem mais curto que a requisição.
  SQS_CONNECTION_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .max(60_000)
    .default(3_000),

  // --------------------------- consumidor e workers -------------------------------

  /*
    Mensagens por `ReceiveMessage`. Dez é o teto da própria AWS.

    Lote maior reduz chamadas vazias, e aumenta o tempo que a última mensagem
    do lote passa invisível esperando a vez — por isso ele e o
    `VisibilityTimeout` da topologia caminham juntos.
  */
  CONSUMER_MAX_MESSAGES: z.coerce.number().int().min(1).max(10).default(10),

  /*
    Prazo do encerramento gracioso: no `SIGTERM`, o processo conclui
    as mensagens em andamento **ou** devolva a visibilidade delas; este é o
    tempo que o processo espera pela primeira opção antes de recorrer à
    segunda. Precisa ser menor que o prazo que o orquestrador dá entre
    `SIGTERM` e `SIGKILL`, que no Compose é 10 s por padrão.
  */
  WORKER_SHUTDOWN_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(100)
    .max(60_000)
    .default(8_000),

  /*
    Intervalo entre passadas do publicador da outbox.

    Um segundo é o teto de latência que um evento espera no caminho feliz. O
    worker não dorme quando o lote volta cheio — só quando não há mais nada
    vencido —, então reduzir este número não aumenta throughput, apenas o
    número de consultas vazias ao banco.
  */
  OUTBOX_POLL_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(10)
    .max(60_000)
    .default(1_000),

  // Eventos reivindicados por passada, com `for update skip locked`.
  OUTBOX_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(20),

  /*
    Intervalo entre passadas do worker de referência pendente.

    Mais folgado que o da outbox de propósito: a menor espera da agenda da
    agenda é de 11 minutos, então varrer com frequência de segundos só
    geraria consulta vazia.
  */
  REFERENCE_POLL_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(10)
    .max(600_000)
    .default(5_000),

  // Transações de referência pendente reavaliadas por passada.
  REFERENCE_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(20),

  // --------------------------- observabilidade ------------------------------
  /*
    Prazo de cada verificação do `/health/ready`.

    Curto de propósito: readiness responde sobre o estado atual, e uma
    dependência lenta é uma dependência indisponível para efeito de aceitar
    tráfego. Precisa ser menor que o prazo que o orquestrador dá à sonda.
  */
  HEALTH_CHECK_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(100)
    .max(30_000)
    .default(2_000),
});

export type Env = z.infer<typeof envSchema>;

/*
  Usada como `validate` do ConfigModule. Lança com todas as variáveis
  inválidas de uma vez, não apenas com a primeira.
*/
export function validateEnv(raw: Record<string, unknown>): Env {
  const result = envSchema.safeParse(raw);

  if (!result.success) {
    const details = result.error.issues
      .map(
        (issue) => `  - ${issue.path.join('.') || '(raiz)'}: ${issue.message}`,
      )
      .join('\n');

    throw new Error(
      `Configuração de ambiente inválida:\n${details}\n\n` +
        'Compare o seu .env com o contrato em .env.example.',
    );
  }

  return result.data;
}
