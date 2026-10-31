import { InvariantViolationError } from '../shared/invariant-violation-error';
import type { IntegrationEvent } from './integration-event';

export interface OutboxMessageState {
  readonly id: string;
  readonly aggregateId: string;
  readonly eventType: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly occurredAt: Date;
  readonly attempts: number;
  readonly nextAttemptAt?: Date | undefined;
  readonly publishedAt?: Date | undefined;
}

// Primeira espera: 1 s.
const BASE_RETRY_DELAY_MS = 1_000;

/*
  Teto da espera: 5 min.

  Sem teto, o backoff exponencial chega a horas depois de uma dúzia de
  tentativas, e um evento pendente ficaria parado muito tempo depois de o SQS
  voltar. Com teto, o pior caso de atraso é conhecido.
*/
const MAX_RETRY_DELAY_MS = 300_000;

function backoffDelayMs(attempts: number): number {
  const exponential = BASE_RETRY_DELAY_MS * 2 ** Math.max(0, attempts - 1);
  return Math.min(exponential, MAX_RETRY_DELAY_MS);
}

/*
  Evento aguardando publicação.

  Gravado na **mesma transação** do efeito financeiro e publicado depois, por
  um worker. É assim que a regra "nunca publicar antes do commit" é atendida
  sem transação distribuída: o evento já está no banco
  quando o commit confirma, e qualquer instância o encontra pendente.

  Não há limite de tentativas, de propósito. Publicação duplicada é aceita e
  segura para o consumidor, que é idempotente; perder um evento confirmado
  não é aceitável em nenhuma circunstância. Então a espera cresce até o teto
  e o evento continua
  pendente — um evento travado é um problema visível na métrica de outbox
  lag, enquanto um evento descartado é um problema invisível.
*/
export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt: Date | undefined,
    private _publishedAt: Date | undefined,
  ) {}

  /*
    O `id` da linha é o `eventId` do evento.

    Reaproveitar o identificador em vez de gerar outro torna o enfileiramento
    idempotente de graça: reexecutar a mesma operação dentro de uma
    transação que foi revertida e refeita não cria duas linhas, porque a
    chave primária é a mesma.
  */
  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.eventType,
      event.toJSON(),
      event.occurredAt,
      0,
      undefined,
      undefined,
    );
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      state.payload,
      state.occurredAt,
      state.attempts,
      state.nextAttemptAt,
      state.publishedAt,
    );
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }

  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  // Pendente e com a espera do backoff já vencida.
  isDue(now: Date): boolean {
    if (!this.isPending()) return false;
    if (this._nextAttemptAt === undefined) return true;
    return this._nextAttemptAt.getTime() <= now.getTime();
  }

  markPublished(at: Date): void {
    if (this._publishedAt !== undefined) {
      throw new InvariantViolationError(
        `Evento ${this.id} já marcado como publicado`,
      );
    }
    this._publishedAt = at;
  }

  // Incrementa `attempts` e adia a próxima tentativa com backoff.
  scheduleRetry(now: Date): void {
    if (this._publishedAt !== undefined) {
      throw new InvariantViolationError(
        `Evento ${this.id} já publicado; não há o que reagendar`,
      );
    }
    this._attempts += 1;
    this._nextAttemptAt = new Date(
      now.getTime() + backoffDelayMs(this._attempts),
    );
  }
}
