import { InvariantViolationError } from '../shared/invariant-violation-error';

export interface ReceiveInboxProps {
  readonly messageId: string;
  readonly consumerName: string;
  readonly payloadHash: string;
  readonly receivedAt: Date;
}

export interface InboxMessageState extends ReceiveInboxProps {
  readonly processedAt?: Date | undefined;
}

/*
  Registro de mensagem consumida — a garantia de deduplicação.

  A chave é o par `(consumerName, messageId)`, e é chave primária composta no
  schema. O `consumerName` entra porque consumidores diferentes podem precisar
  processar a mesma mensagem de forma independente; deduplicar só por
  `messageId` fecharia essa porta sem necessidade.

  O registro é gravado na **mesma transação SQL** do efeito financeiro, e o
  `ack` sai só depois do commit. É o que fecha a janela entre commit e ack:
  morrendo ali, a mensagem é reentregue e encontrada aqui como já processada.
  Cache em memória não serve como garantia de idempotência justamente porque
  nada em memória sobrevive a esse crash.
*/
export class InboxMessage {
  private constructor(
    public readonly messageId: string,
    public readonly consumerName: string,
    public readonly payloadHash: string,
    public readonly receivedAt: Date,
    private _processedAt: Date | undefined,
  ) {}

  static receive(props: ReceiveInboxProps): InboxMessage {
    return new InboxMessage(
      props.messageId,
      props.consumerName,
      props.payloadHash,
      props.receivedAt,
      undefined,
    );
  }

  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(
      state.messageId,
      state.consumerName,
      state.payloadHash,
      state.receivedAt,
      state.processedAt,
    );
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  isProcessed(): boolean {
    return this._processedAt !== undefined;
  }

  markProcessed(at: Date): void {
    if (this._processedAt !== undefined) {
      throw new InvariantViolationError(
        `Mensagem ${this.messageId} já marcada como processada`,
      );
    }
    this._processedAt = at;
  }
}
