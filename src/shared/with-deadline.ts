/*
  Prazo máximo para uma operação de E/S.

  Timeout é indisponibilidade, e indisponibilidade não pode virar
  travamento. Uma dependência que aceita a conexão e nunca responde é o pior
  caso: sem prazo, quem espera por ela espera para sempre, e um endpoint de
  readiness que não responde é indistinguível de um processo quebrado — que é
  exatamente a distinção que ele existe para permitir.
*/

/*
  Folga entre o cancelamento e a garantia externa.

  Quem tem como cancelar de verdade — um `AbortSignal` no cliente HTTP, por
  exemplo — recebe o prazo cheio. `withDeadline` recebe o prazo mais esta
  folga, de modo que o cancelamento normalmente vença a corrida e produza o
  erro mais informativo, e a garantia externa só apareça quando o
  cancelamento for ignorado.
*/
export const ABORT_GRACE_MS = 250;

export class DeadlineExceededError extends Error {
  constructor(
    readonly label: string,
    readonly timeoutMs: number,
  ) {
    super(`${label} não respondeu em ${String(timeoutMs)} ms`);
    this.name = 'DeadlineExceededError';
  }
}

/*
  Resolve com o resultado de `work`, ou rejeita com `DeadlineExceededError`.

  **Não cancela** `work`: a operação subjacente continua até terminar por
  conta própria. Quem puder cancelar de verdade deve fazê-lo — o cliente SQS
  recebe um `AbortSignal`, que aborta a requisição HTTP. Esta função é a
  garantia externa, para que a resposta exista mesmo que o cancelamento não
  seja respeitado.
*/
export async function withDeadline<T>(
  work: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new DeadlineExceededError(label, timeoutMs));
    }, timeoutMs);
  });

  try {
    /*
      `Promise.race` já registra handler nas duas promessas, então nenhuma
      rejeição tardia vira unhandled rejection.
    */
    return await Promise.race([work, deadline]);
  } finally {
    /*
      Sem isto, o timer pendente mantém o event loop vivo e o processo
      demora a encerrar no SIGTERM.
    */
    clearTimeout(timer);
  }
}
