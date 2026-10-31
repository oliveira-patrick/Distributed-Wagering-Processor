/*
   Instâncias de verdade, em processos separados.

   Corretude com **três ou mais instâncias** e paralelismo real não se
   demonstram com `Promise.all` sobre o mesmo processo: um só processo
   compartilha o pool de conexões, o event loop e a memória, e nenhum dos três
   é compartilhado entre instâncias de verdade.

   Então aqui os processos são de verdade — `bun src/main.ts` e
  `bun src/worker.ts` —, apontados para o banco e as filas descartáveis da
   suíte por variáveis de ambiente. É a mesma aplicação que o Compose sobe, só
   sem a imagem no meio: um `docker build` por alteração de código tornaria
   esta suíte lenta demais para ser executada com frequência, e é a frequência
   que faz um teste de concorrência valer algo.
*/
import { createTestQueues } from '../../integration/support/test-queues';
import type { TestQueues } from '../../integration/support/test-queues';

export type InstanceRole = 'api' | 'worker';

const ENTRYPOINT: Readonly<Record<InstanceRole, string>> = {
  api: 'src/main.ts',
  worker: 'src/worker.ts',
};

// Quanto se espera por uma instância que está subindo. /
const READY_BUDGET_MS = 60_000;

export interface SpawnedInstance {
  readonly role: InstanceRole;
  readonly port: number;
  readonly baseUrl: string;
  readonly pid: number;
  // Encerramento abrupto — é o "o processo morreu" dos testes de falha.
  kill(): void;
  // `SIGTERM` e espera — o encerramento gracioso da aplicação.
  terminate(): Promise<void>;
  // A saída acumulada, para diagnóstico quando um teste falha.
  output(): Promise<string>;
}

/*
  Uma porta livre.

  Abre e fecha um servidor na porta 0, que o sistema operacional escolhe. Há
  uma janela entre fechar e a instância abrir, e ela é aceita: a alternativa
  é numerar portas a partir de uma base, o que colide quando duas execuções
  da suíte se cruzam — falha bem mais confusa de diagnosticar que um
  `EADDRINUSE` imediato.
*/
async function freePort(): Promise<number> {
  const server = Bun.serve({ port: 0, fetch: () => new Response('') });
  const { port } = server;

  /*
    Aguardado, e não descartado: a porta precisa estar livre **antes** de o
    processo filho tentar abri-la, ou o `EADDRINUSE` acontece contra este
    próprio servidor de sondagem.
  */
  await server.stop(true);

  /*
    O tipo admite `undefined` porque um servidor pode escutar em socket unix,
    que não tem porta. Aqui sempre há porta; a guarda existe para não
    propagar um `NaN` silencioso para a variável de ambiente da instância.
  */
  if (port === undefined) {
    throw new Error('não foi possível obter uma porta livre');
  }

  return port;
}

export interface SpawnOptions {
  readonly role: InstanceRole;
  readonly databaseName: string;
  readonly queues: TestQueues;
  // Ajustes pontuais: intervalo de polling, nome do consumidor, lote.
  readonly env?: Readonly<Record<string, string>>;
}

export async function spawnInstance(
  options: SpawnOptions,
): Promise<SpawnedInstance> {
  const port = await freePort();
  const portVariable = options.role === 'api' ? 'APP_PORT' : 'WORKER_PORT';

  const proc = Bun.spawn(['bun', ENTRYPOINT[options.role]], {
    env: {
      ...process.env,
      POSTGRES_DB: options.databaseName,
      SQS_QUEUE_NAME: options.queues.input.name,
      SQS_DLQ_NAME: options.queues.input.deadLetterName,
      SQS_EVENTS_QUEUE_NAME: options.queues.events.name,
      SQS_EVENTS_DLQ_NAME: options.queues.events.deadLetterName,
      [portVariable]: String(port),
      /*
        Silencioso de propósito: três instâncias em `info` enterram a saída
        do teste. A saída fica capturada e é impressa só quando algo falha.
      */
      LOG_LEVEL: 'warn',
      ...options.env,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const baseUrl = `http://127.0.0.1:${String(port)}`;
  const collected: Promise<string> = (async (): Promise<string> => {
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return `${out}\n${err}`;
  })();

  const instance: SpawnedInstance = {
    role: options.role,
    port,
    baseUrl,
    pid: proc.pid,
    kill: (): void => {
      proc.kill(9);
    },
    terminate: async (): Promise<void> => {
      proc.kill(15);
      await proc.exited;
    },
    output: async (): Promise<string> => collected,
  };

  await waitUntilReady(instance, proc);
  return instance;
}

/*
  Espera a instância responder em `/health/live`.

  `live`, e não `ready`: o que se espera aqui é o processo ter subido e estar
  roteando. O `ready` depende de PostgreSQL e SQS, e usá-lo misturaria "a
  instância não subiu" com "a infraestrutura caiu" — exatamente a distinção
  que os dois endpoints existem para permitir.
*/
async function waitUntilReady(
  instance: SpawnedInstance,
  proc: ReturnType<typeof Bun.spawn>,
): Promise<void> {
  const deadline = Date.now() + READY_BUDGET_MS;

  for (;;) {
    if (proc.exitCode !== null) {
      throw new Error(
        `a instância ${instance.role} morreu durante a inicialização ` +
          `(exit ${String(proc.exitCode)}):\n${await instance.output()}`,
      );
    }

    try {
      const response = await fetch(`${instance.baseUrl}/health/live`);
      if (response.ok) {
        return;
      }
    } catch {
      // Ainda não está escutando. Esperado nos primeiros instantes.
    }

    if (Date.now() >= deadline) {
      proc.kill(9);
      throw new Error(
        `a instância ${instance.role} não respondeu em ` +
          `${String(READY_BUDGET_MS)} ms`,
      );
    }

    await Bun.sleep(100);
  }
}

// Sobe `count` instâncias do mesmo papel, em paralelo.
export async function spawnCluster(
  count: number,
  options: SpawnOptions,
): Promise<SpawnedInstance[]> {
  return Promise.all(
    Array.from({ length: count }, () => spawnInstance(options)),
  );
}

export async function terminateAll(
  instances: readonly SpawnedInstance[],
): Promise<void> {
  await Promise.allSettled(instances.map((instance) => instance.terminate()));
}

export { createTestQueues };
