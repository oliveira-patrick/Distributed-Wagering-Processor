export interface IntegrationEventProps<T> {
  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string | undefined;
  readonly occurredAt: Date;
  readonly data: T;
}

/*
  Envelope serializado — é o que vai para a coluna `payload` da outbox e,
  depois, para o corpo da mensagem publicada.

  Declarado como `type` e não `interface` de propósito: só um alias de tipo
  ganha index signature implícita, e sem ela o envelope não seria atribuível
  a `Record<string, unknown>`, que é o tipo do payload da outbox.
*/

/* 
  eslint-disable-next-line @typescript-eslint/consistent-type-definitions -- ver acima: 
  interface não ganha index signature implícita 
*/
export type IntegrationEventEnvelope<T> = {
  readonly eventId: string;
  readonly eventType: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string | undefined;
  readonly occurredAt: string;
  readonly version: number;
  readonly data: T;
};

/*
  Evento de integração.

  `eventType` e `version` são declarados **no tipo**, pela subclasse, e não
  passados como string no ponto de criação. A diferença importa na prática:
  com a string no call site, dois lugares que
  publicam o mesmo evento podem divergir no nome, e o consumidor descobre
  tarde. Como membro abstrato, o nome é propriedade da classe e o compilador
  cobra quem esquecer.

  `data` carrega `MoneyProps` — string decimal —, nunca instâncias de
  `Money`. O payload precisa ser JSON estável e versionável, e um value
  object serializado por acidente não é nenhum dos dois.
*/
export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;

  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId: string | undefined;
  readonly occurredAt: Date;
  readonly data: Readonly<T>;

  protected constructor(props: IntegrationEventProps<T>) {
    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    this.causationId = props.causationId;
    this.occurredAt = props.occurredAt;
    this.data = props.data;
  }

  toJSON(): IntegrationEventEnvelope<T> {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      causationId: this.causationId,
      occurredAt: this.occurredAt.toISOString(),
      version: this.version,
      data: this.data,
    };
  }
}

// Contexto de correlação que acompanha a operação do começo ao fim.
export interface EventContext {
  readonly eventId: string;
  readonly correlationId: string;
  readonly causationId?: string | undefined;
  readonly occurredAt: Date;
}
