import { Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';

import type {
  Repositories,
  UnitOfWork,
} from '../../application/ports/unit-of-work';
import { MikroOrmWagerTransactionRepository } from './repositories/wager-transaction.repository';
import { MikroOrmWalletLedgerRepository } from './repositories/wallet-ledger.repository';
import { MikroOrmWalletRepository } from './repositories/wallet.repository';
import {
  MikroOrmInboxRepository,
  MikroOrmOutboxRepository,
} from './repositories/messaging.repositories';

/*
  Monta os repositórios sobre **um** `EntityManager`.

  Todos compartilham a mesma instância, e é isso que garante que escrevam na
  mesma transação. Um repositório construído sobre outro EM pegaria conexão
  própria do pool e sairia da transação sem avisar — o lançamento no ledger
  comitaria sozinho, separado do evento na outbox.
*/
export function buildRepositories(em: EntityManager): Repositories {
  return {
    wallets: new MikroOrmWalletRepository(em),
    transactions: new MikroOrmWagerTransactionRepository(em),
    ledger: new MikroOrmWalletLedgerRepository(em),
    inbox: new MikroOrmInboxRepository(em),
    outbox: new MikroOrmOutboxRepository(em),
  };
}

/*
  Fronteira transacional sobre o MikroORM.

  `em.transactional` abre a transação, deriva um EM ligado a ela e comita no
  retorno ou reverte na exceção. Os repositórios são construídos sobre esse
  EM derivado e só existem dentro do callback, de modo que não há como uma
  escrita escapar da transação: não existe repositório fora dela.
*/
@Injectable()
export class MikroOrmUnitOfWork implements UnitOfWork {
  constructor(private readonly em: EntityManager) {}

  async run<T>(work: (repositories: Repositories) => Promise<T>): Promise<T> {
    return this.em.transactional(async (scoped) =>
      work(buildRepositories(scoped)),
    );
  }
}
