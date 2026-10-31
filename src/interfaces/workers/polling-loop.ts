// O que a passada descobriu: havia mais trabalho, ou a fila secou.
export type TickOutcome = 'again' | 'idle';

export interface PollingLoopOptions {
  // Espera entre passadas, só quando a passada anterior não achou nada.
  readonly idleDelayMs: number;
  // Espera depois de uma falha, para não girar em vazio sobre um erro.
  readonly errorDelayMs?: number;
}

/*
  Laço de polling com encerramento interrompível.

  Extraído porque o publicador da outbox e o worker de referência pendente
  têm exatamente a mesma forma, e a parte difícil dela não é o laço: é o
  `sleep` que **acorda** quando o shutdown chega. Um `setTimeout` comum de
  cinco segundos faria um worker ocioso levar cinco segundos para encerrar, e
  o Compose mata o processo em dez — então dois workers assim já estouram o
  prazo do contêiner.

  `again` não dorme: quando o lote volta cheio, provavelmente há mais
  trabalho vencido, e esperar o intervalo nesse caso transformaria uma fila
  acumulada em latência artificial.
*/
export class PollingLoop {
  private running = false;
  private loop: Promise<void> | undefined;
  private wake: (() => void) | undefined;

  constructor(
    private readonly tick: () => Promise<TickOutcome>,
    private readonly onError: (error: unknown) => void,
    private readonly options: PollingLoopOptions,
  ) {}

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.loop = this.run();
  }

  /*
    Para o laço e espera a passada em curso.

    Devolve `false` quando o prazo estourou — o chamador decide se isso é um
    aviso ou um erro. Não mata a passada em andamento: abandonar uma
    transação pela metade não a reverte mais rápido, e o PostgreSQL já cuida
    disso quando a conexão cai.
  */
  async stop(timeoutMs: number): Promise<boolean> {
    if (!this.running) {
      return true;
    }
    this.running = false;
    this.wake?.();

    const pending = this.loop ?? Promise.resolve();
    this.loop = undefined;

    return Promise.race([
      pending.then(() => true),
      this.delay(timeoutMs).then(() => false),
    ]);
  }

  private async run(): Promise<void> {
    while (this.isRunning()) {
      try {
        const outcome = await this.tick();

        if (outcome === 'idle') {
          await this.sleep(this.options.idleDelayMs);
        }
      } catch (error) {
        if (!this.isRunning()) {
          return;
        }
        this.onError(error);
        await this.sleep(this.options.errorDelayMs ?? this.options.idleDelayMs);
      }
    }
  }

  /*
    Em método, e não `this.running` direto.

    Lido direto, o compilador o estreita a partir da condição do `while` e
    conclui que o teste no `catch` nunca é verdadeiro — mas `stop` o altera
    de fora, entre dois `await`, que é exatamente o caso tratado ali.
  */
  private isRunning(): boolean {
    return this.running;
  }

  // Espera que o `stop` pode encurtar.
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      this.wake = (): void => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
