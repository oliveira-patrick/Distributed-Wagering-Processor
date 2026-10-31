import type { InboxRepository } from './inbox.repository';
import type { OutboxRepository } from './outbox.repository';
import type { WagerTransactionRepository } from './wager-transaction.repository';
import type { WalletLedgerRepository } from './wallet-ledger.repository';
import type { WalletRepository } from './wallet.repository';

// Os repositórios ligados a uma transação.
export interface Repositories {
  readonly wallets: WalletRepository;
  readonly transactions: WagerTransactionRepository;
  readonly ledger: WalletLedgerRepository;
  readonly inbox: InboxRepository;
  readonly outbox: OutboxRepository;
}

/*
  Fronteira transacional.

  Os repositórios **só** existem dentro de `run`, entregues pelo callback.
  Não é cerimônia: é o que torna a atomicidade estrutural em vez de uma regra
  que alguém precisa lembrar. Com repositórios injetados direto no caso de
  uso, nada impediria uma escrita fora da transação — e as duas garantias que
  mais dependem disso são as duas mais caras de errar: o lançamento no
  ledger e o evento na outbox precisam estar no **mesmo** commit, e publicar
  antes do commit é falha.

  Leitura também passa por aqui, inclusive a que não decide nada. Dois
  caminhos — um transacional e um solto — seriam dois lugares para escolher
  errado, e `findByIdForUpdate` fora de transação é um lock sem significado.
*/
export interface UnitOfWork {
  run<T>(work: (repositories: Repositories) => Promise<T>): Promise<T>;
}

// Token de injeção: a interface não existe em tempo de execução.
export const UNIT_OF_WORK = 'UNIT_OF_WORK';
