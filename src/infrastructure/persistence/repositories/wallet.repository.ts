import { LockMode } from '@mikro-orm/core';
import type { EntityManager } from '@mikro-orm/postgresql';

import type { WalletRepository } from '../../../application/ports/wallet.repository';
import type { Wallet } from '../../../domain/wallet/wallet';
import { walletSchema } from '../entities/wallet.row';
import {
  toWalletDomain,
  toWalletRow,
  toWalletUpdate,
} from '../mappers/wallet.mapper';
import { FRESH } from './read-options';
import { tryInsertRow } from './try-insert';

export class MikroOrmWalletRepository implements WalletRepository {
  constructor(private readonly em: EntityManager) {}

  async findByIdForUpdate(id: string): Promise<Wallet | undefined> {
    const row = await this.em.findOne(
      walletSchema,
      { id },
      { ...FRESH, lockMode: LockMode.PESSIMISTIC_WRITE },
    );
    return row === null ? undefined : toWalletDomain(row);
  }

  async findById(id: string): Promise<Wallet | undefined> {
    const row = await this.em.findOne(walletSchema, { id }, FRESH);
    return row === null ? undefined : toWalletDomain(row);
  }

  async findByPlayerAndCurrency(
    playerId: string,
    currency: string,
  ): Promise<Wallet | undefined> {
    const row = await this.em.findOne(
      walletSchema,
      { playerId, currency },
      FRESH,
    );
    return row === null ? undefined : toWalletDomain(row);
  }

  async tryInsert(wallet: Wallet): Promise<boolean> {
    const { inserted } = await tryInsertRow(
      this.em,
      walletSchema,
      toWalletRow(wallet),
    );
    return inserted;
  }

  /*
    `nativeUpdate` em vez de flush do Unit of Work: o `update` precisa sair
    **aqui**, dentro do lock que já está de pé, e não numa ordem escolhida
    pelo ORM no fim da transação.
  */
  async save(wallet: Wallet): Promise<void> {
    await this.em.nativeUpdate(
      walletSchema,
      { id: wallet.id },
      toWalletUpdate(wallet),
    );
  }
}
