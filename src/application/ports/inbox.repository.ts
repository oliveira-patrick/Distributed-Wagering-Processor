import type { InboxMessage } from '../../domain/messaging/inbox-message';

export interface InboxRepository {
  find(
    consumerName: string,
    messageId: string,
  ): Promise<InboxMessage | undefined>;

  /*
    Registra o consumo. Devolve `false` quando a mensagem já foi vista por
    este consumidor — é o sinal de deduplicação.

    Como na transação de aposta, a inserção vem primeiro e a colisão da chave
    primária composta é a resposta. Grava na **mesma transação** do efeito
    financeiro: é o que fecha a janela entre commit e `ack`.
  */
  tryInsert(message: InboxMessage): Promise<boolean>;

  save(message: InboxMessage): Promise<void>;
}
