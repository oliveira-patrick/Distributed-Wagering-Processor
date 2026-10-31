import type { WagerTransaction } from '../../domain/wagering/wager-transaction';

/*
  Qual unicidade colidiu.

  Um booleano não bastaria: a tabela tem três unicidades com significados de
  negócio diferentes, e colapsá-las faria o caso de uso procurar um replay
  que não existe quando o que aconteceu foi uma reversão duplicada. O nome da
  constraint é detalhe de schema e fica no adapter; o que atravessa a porta é
  o significado.
*/
export const TransactionConflict = {
  // Mesma chave de idempotência: replay ou conflito, decidido pelo hash.
  IdempotencyKey: 'IDEMPOTENCY_KEY',
  // Mesmo par `(provider, id externo)` com outra chave de idempotência.
  ProviderExternalId: 'PROVIDER_EXTERNAL_ID',
  // A referência já foi revertida por uma operação do mesmo tipo.
  AlreadyReversed: 'ALREADY_REVERSED',
} as const;

export type TransactionConflict =
  (typeof TransactionConflict)[keyof typeof TransactionConflict];

export type TransactionInsertOutcome =
  | { readonly inserted: true }
  | { readonly inserted: false; readonly conflict: TransactionConflict };

export interface WagerTransactionRepository {
  /*
    Insere a transação.

    É a primeira coisa que o caso de uso faz, antes de qualquer consulta de
    duplicidade: a unicidade no schema é que decide o vencedor, e a colisão é
    caminho normal, não erro. Consultar antes de inserir devolveria "não
    existe" para as duas tentativas concorrentes.

    Resultado em vez de exceção porque a colisão é um desfecho esperado desta
    operação. O adapter garante que a transação em curso continue utilizável
    depois dela: no PostgreSQL, violação de constraint aborta a transação
    inteira, então a inserção fica isolada num savepoint para que o caminho
    de replay possa seguir lendo e montando a resposta.
  */
  tryInsert(transaction: WagerTransaction): Promise<TransactionInsertOutcome>;

  save(transaction: WagerTransaction): Promise<void>;

  findById(id: string): Promise<WagerTransaction | undefined>;

  findByIdempotencyKey(key: string): Promise<WagerTransaction | undefined>;

  // Resolução de referência: `(provider, id externo)` é a chave natural.
  findByProviderAndExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransaction | undefined>;

  // Fila do worker de referência: aguardando, com a espera vencida.
  findDueForReference(
    now: Date,
    limit: number,
  ): Promise<readonly WagerTransaction[]>;
}
