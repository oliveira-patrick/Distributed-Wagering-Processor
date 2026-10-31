import type {
  LogContext,
  LoggerPort,
} from '../../application/ports/logger.port';

/*
  Níveis, do mais grave ao mais verboso.

  A ordem é o que permite comparar: um registro sai quando a severidade dele
  é menor ou igual ao nível configurado.
*/
const SEVERITY = {
  fatal: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
  trace: 5,
} as const;

export type LogLevel = keyof typeof SEVERITY;

// Campos do envelope, que o contexto não pode sobrescrever.
const RESERVED_FIELDS: readonly string[] = ['level', 'time', 'msg'];

/*
  Logs estruturados em JSON — uma linha por registro.

  A correlação acontece por `correlationId`, `messageId`, `transactionId`,
  `walletId` e `providerId`, e payload financeiro completo **não** entra no
  log. A primeira parte é o formato; a segunda já está garantida pelo tipo de
  `LogContext`, que só aceita escalares e por isso não deixa passar um objeto
  de domínio por engano.

  Escreve direto em `stdout`, sem passar pelo `Logger` do Nest. Não é
  preferência: o logger do Nest prefixa cada linha com carimbo de tempo,
  nome de contexto e códigos de cor ANSI. Qualquer um dos três quebra o
  parsing da linha como JSON, que é o único motivo de o formato ser JSON.

  A mensagem vai em `msg` e os campos ficam no topo do objeto, não aninhados
  em `context`: é o que permite consultar por `correlationId` sem o coletor
  ter de saber a forma do nosso envelope.
*/
export class JsonLogger implements LoggerPort {
  private readonly threshold: number;

  constructor(
    level: LogLevel,
    private readonly sink: (line: string) => void = defaultSink,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.threshold = SEVERITY[level];
  }

  info(message: string, context?: LogContext): void {
    this.write('info', message, context);
  }

  warn(message: string, context?: LogContext): void {
    this.write('warn', message, context);
  }

  error(message: string, context?: LogContext): void {
    this.write('error', message, context);
  }

  private write(
    level: LogLevel,
    message: string,
    context: LogContext | undefined,
  ): void {
    if (SEVERITY[level] > this.threshold) {
      return;
    }

    const record: Record<string, string | number | boolean> = {
      level,
      time: this.now().toISOString(),
      msg: message,
    };

    for (const [field, value] of Object.entries(context ?? {})) {
      /*
        Campo indefinido é omitido em vez de virar `null`. Um `null` no log
        obriga quem consulta a tratar dois valores para "não informado".
      */
      if (value === undefined) {
        continue;
      }
      /*
        `level`, `time` e `msg` são do envelope. Um contexto que os trouxesse
        sobrescreveria o envelope silenciosamente, e o registro passaria a
        mentir sobre a própria severidade.
      */
      record[RESERVED_FIELDS.includes(field) ? `_${field}` : field] = value;
    }

    this.sink(JSON.stringify(record));
  }
}

function defaultSink(line: string): void {
  process.stdout.write(`${line}\n`);
}
