import type { Money } from '../../domain/money/money';
import type { WalletLedgerEntry } from '../../domain/wallet/wallet-ledger-entry';
import type { LedgerCursor } from '../contracts/ledger-cursor';

export interface LedgerPage {
  readonly entries: readonly WalletLedgerEntry[];
  // Ausente quando a página lida é a última.
  readonly nextCursor: LedgerCursor | undefined;
}

export interface LedgerTotals {
  // Saldo reconstruído somando o ledger.
  readonly balance: Money;
  readonly entries: number;
}

/*
  Ledger — apenas inserção e leitura.

  Não há `save` nem `delete`, e a ausência é a garantia: é proibido
  sobrescrever ou excluir lançamento. O banco também recusa, por trigger, mas
  a porta nem oferece a operação.
*/
export interface WalletLedgerRepository {
  append(entry: WalletLedgerEntry): Promise<void>;

  // Em ordem cronológica. Para wallets pequenas e para teste.
  listByWallet(walletId: string): Promise<readonly WalletLedgerEntry[]>;

  /*
    Página do extrato, por keyset — `GET /wallets/:id/ledger`.

    Paginação por chave, e não por offset, porque o cursor precisa ser estável
    sob inserção concorrente. Ver `contracts/ledger-cursor.ts`.
  */
  pageByWallet(
    walletId: string,
    options: {
      readonly after: LedgerCursor | undefined;
      readonly limit: number;
    },
  ): Promise<LedgerPage>;

  // Existência do lançamento de uma transação — a unicidade está no schema.
  findByWalletAndTransaction(
    walletId: string,
    transactionId: string,
  ): Promise<WalletLedgerEntry | undefined>;

  /*
    Soma com sinal e contagem, numa consulta só, calculadas **dentro** do
    PostgreSQL sobre `numeric`.

    Uma consulta e não duas: a reconciliação compara saldo com soma e informa
    quantos lançamentos conferiu, e os três números precisam descrever o mesmo
    instante. Em duas consultas, um lançamento inserido no meio deixaria o
    relatório internamente inconsistente — justamente o tipo de divergência
    que ele existe para detectar.

    A soma vive aqui, e não em `rebuildBalance`, para não trazer um ledger
    inteiro para a memória. As duas contas têm de concordar, e é por isso que
    a coluna é `numeric(20, 2)`: a mesma aritmética exata dos dois lados.
  */
  totalsByWallet(walletId: string, currency: string): Promise<LedgerTotals>;
}
