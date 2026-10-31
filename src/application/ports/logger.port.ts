/*
  Campos estruturados de um registro de log.

  A correlação acontece por `correlationId`, `messageId`, `transactionId`,
  `walletId` e `providerId`, e payload financeiro completo **não** entra no
  log. Daí campos nomeados em vez de uma mensagem formatada: o que
  entra aqui é identificador e contagem, não valor monetário nem corpo de
  requisição.
*/
export type LogContext = Readonly<
  Record<string, string | number | boolean | undefined>
>;

/*
  Porta de log.

  A implementação de produção escreve uma linha JSON por registro.
  Divergência de reconciliação, por exemplo, precisa ser **logada** — não só
  sinalizada na resposta —, e trocar a implementação não toca nos casos de
  uso.
*/
export interface LoggerPort {
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
}

export const LOGGER = 'LOGGER';
