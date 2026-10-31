import type { Wallet } from '../../domain/wallet/wallet';

export interface WalletRepository {
  /*
    Carrega a wallet com lock pessimista de linha.

    É aqui que a concorrência é arbitrada: a unidade é a `walletId`, e quem
    decide a ordem é o PostgreSQL. Duas transações que pedem a mesma wallet
    entram em fila; wallets diferentes não se bloqueiam, o que mantém a
    exigência de não haver lock global satisfeita.

    Consultar o saldo depois deste lock e decidir em seguida **não** é o
    `read → calculate → update` que se quer evitar: leitura e escrita
    acontecem dentro do mesmo lock, na mesma transação.
  */
  findByIdForUpdate(id: string): Promise<Wallet | undefined>;

  // Leitura sem lock, para consulta que não decide nada.
  findById(id: string): Promise<Wallet | undefined>;

  // A unicidade do par é garantida pelo schema.
  findByPlayerAndCurrency(
    playerId: string,
    currency: string,
  ): Promise<Wallet | undefined>;

  /*
    Abre a wallet. Devolve `false` quando já existe wallet para o par
    `(playerId, currency)` — a unicidade está no schema, e a colisão é
    `WALLET_ALREADY_EXISTS`, não erro de infraestrutura.
  */
  tryInsert(wallet: Wallet): Promise<boolean>;

  // Persiste o que o agregado mudou. Exige que ele tenha vindo deste repositório.
  save(wallet: Wallet): Promise<void>;
}
