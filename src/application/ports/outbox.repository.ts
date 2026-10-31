import type { OutboxMessage } from '../../domain/messaging/outbox-message';

export interface OutboxRepository {
  /*
    Enfileira o evento na mesma transação do efeito financeiro.

    É o que atende a regra "nunca publicar antes do commit" sem
    transação distribuída: quando o commit confirma, o evento já está no
    banco, e qualquer instância o encontra pendente.
  */
  enqueue(message: OutboxMessage): Promise<void>;

  /*
    Reivindica eventos pendentes e vencidos com `for update skip locked`.

    `skip locked` é o que permite vários publicadores concorrentes sem lock
    global e sem publicar o mesmo evento duas vezes na mesma passada: cada
    worker leva um lote disjunto e quem chega depois pula as linhas já
    tomadas, em vez de esperar por elas.
  */
  claimDue(now: Date, limit: number): Promise<readonly OutboxMessage[]>;

  save(message: OutboxMessage): Promise<void>;

  /*
    Quantos eventos seguem pendentes e qual o mais antigo.

    Existe para a métrica de **outbox lag**. Lag é
    estado global do banco, não contagem local do processo: com três
    instâncias, cada uma publica uma parte, e só o banco sabe o quanto
    sobrou. Por isso é gauge lido daqui, e não contador incrementado por
    quem publica.
  */
  pendingStats(): Promise<OutboxPendingStats>;
}

export interface OutboxPendingStats {
  readonly pending: number;
  // Ausente quando não há nada pendente.
  readonly oldestOccurredAt?: Date | undefined;
}
