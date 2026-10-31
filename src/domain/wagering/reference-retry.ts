/*
  Agenda de reprocessamento de referência ausente.

  O ADR-004 fixou **8 tentativas** dentro de uma janela de 24 horas. Este
  módulo é a aritmética que entrega isso, e os números são derivados, não
  escolhidos a dedo:

  - a primeira tentativa é a própria submissão, que já consultou a referência
    e não a encontrou;
  - restam 7 esperas, cada uma o dobro da anterior;
  - a soma de 7 termos dobrando é `base × (2⁷ − 1)` = `base × 127`;
  - para caber em 24 h: `base ≈ 86 400 s ÷ 127 ≈ 680 s`.

  Daí `base = 11 min`, que dá esperas de 11, 22, 44, 88, 176, 352 e 704
  minutos — **1397 minutos, ou 23 h 17 min** até a oitava e última tentativa.

  O preço de dobrar sem teto é a cauda: uma referência que chegue logo depois
  da sexta tentativa espera quase 12 horas pela sétima. Um teto por espera
  reduziria essa latência e exigiria mais tentativas para cobrir as 24 h —
  trade-off registrado no ADR-004, a ser revisitado com o comportamento real
  dos provedores.
*/
const BASE_DELAY_MINUTES = 11;
const MINUTE_MS = 60_000;

// Tentativas no total, contando a submissão.
export const MAX_REFERENCE_ATTEMPTS = 8;

/*
  Espera até a próxima tentativa.

  @param attemptsSoFar quantas tentativas já aconteceram. `1` depois da
  submissão, e é essa chamada que agenda a segunda.
*/
export function referenceRetryDelayMs(attemptsSoFar: number): number {
  const step = Math.max(0, attemptsSoFar - 1);
  return BASE_DELAY_MINUTES * MINUTE_MS * 2 ** step;
}

// Se ainda há tentativa a fazer, ou se o limite se esgotou.
export function referenceAttemptsExhausted(attemptsSoFar: number): boolean {
  return attemptsSoFar >= MAX_REFERENCE_ATTEMPTS;
}
