import type { EntityManager } from '@mikro-orm/postgresql';

import type { LedgerCursor } from '../../../application/contracts/ledger-cursor';
import type {
  LedgerPage,
  LedgerTotals,
  WalletLedgerRepository,
} from '../../../application/ports/wallet-ledger.repository';
import { LedgerDirection } from '../../../domain/wallet/ledger-direction';
import type { WalletLedgerEntry } from '../../../domain/wallet/wallet-ledger-entry';
import { walletLedgerEntrySchema } from '../entities/wallet-ledger-entry.row';
import type { WalletLedgerEntryRow } from '../entities/wallet-ledger-entry.row';
import { toMoney } from '../mappers/money.column';
import {
  toLedgerEntryDomain,
  toLedgerEntryRow,
} from '../mappers/wallet-ledger-entry.mapper';
import { FRESH } from './read-options';

export class MikroOrmWalletLedgerRepository implements WalletLedgerRepository {
  constructor(private readonly em: EntityManager) {}

  /*
    Inserção direta, sem savepoint: ao contrário da transação de aposta, uma
    colisão em `(wallet_id, transaction_id)` aqui não é caminho de negócio.
    A idempotência já decidiu o vencedor antes de chegar neste ponto, então
    uma segunda tentativa de lançar a mesma transação é anomalia — e anomalia
    em ledger deve derrubar a transação, não ser absorvida.
  */
  async append(entry: WalletLedgerEntry): Promise<void> {
    await this.em.insert(walletLedgerEntrySchema, toLedgerEntryRow(entry));
  }

  async listByWallet(walletId: string): Promise<readonly WalletLedgerEntry[]> {
    const rows = await this.em.find(
      walletLedgerEntrySchema,
      { walletId },
      { ...FRESH, orderBy: { createdAt: 'asc', id: 'asc' } },
    );

    return rows.map(toLedgerEntryDomain);
  }

  /*
    Keyset: `(created_at, id) > (cursor.createdAt, cursor.id)`.

    Escrito como disjunção porque é assim que a comparação lexicográfica de
    tupla se expressa no construtor de query: ou o instante é maior, ou é
    igual e o id desempata. Busca `limit + 1` linhas para descobrir se existe
    próxima página sem precisar de um `count` separado.
  */
  async pageByWallet(
    walletId: string,
    options: {
      readonly after: LedgerCursor | undefined;
      readonly limit: number;
    },
  ): Promise<LedgerPage> {
    const after = options.after;
    const where =
      after === undefined
        ? { walletId }
        : {
            walletId,
            $or: [
              { createdAt: { $gt: after.createdAt } },
              { createdAt: after.createdAt, id: { $gt: after.id } },
            ],
          };

    const rows = await this.em.find(walletLedgerEntrySchema, where, {
      ...FRESH,
      orderBy: { createdAt: 'asc', id: 'asc' },
      limit: options.limit + 1,
    });

    const hasMore = rows.length > options.limit;
    const page = hasMore ? rows.slice(0, options.limit) : rows;
    const last = page.at(-1);

    return {
      entries: page.map(toLedgerEntryDomain),
      nextCursor: hasMore && last !== undefined ? toCursor(last) : undefined,
    };
  }

  async findByWalletAndTransaction(
    walletId: string,
    transactionId: string,
  ): Promise<WalletLedgerEntry | undefined> {
    const row = await this.em.findOne(
      walletLedgerEntrySchema,
      { walletId, transactionId },
      FRESH,
    );
    return row === null ? undefined : toLedgerEntryDomain(row);
  }

  /*
    `em.execute`, e não `em.getConnection().execute`: a segunda pegaria uma
    conexão do pool e sairia da transação em curso, o que faria a
    reconciliação somar um ledger que não é o que a transação está vendo.

    `::text` para que a soma chegue como string decimal exata. O driver já
    entrega `numeric` assim, e o cast deixa a intenção explícita em vez de
    depender desse comportamento.
  */
  async totalsByWallet(
    walletId: string,
    currency: string,
  ): Promise<LedgerTotals> {
    const rows = await this.em.execute<{ total: string; entries: string }[]>(
      `select coalesce(sum(
         case direction when ? then money_amount else -money_amount end
       ), 0)::text as total,
       count(*)::text as entries
       from wallet_ledger_entries
       where wallet_id = ?`,
      [LedgerDirection.Credit, walletId],
    );

    const row = rows[0];

    return {
      balance: toMoney(row?.total ?? '0', currency),
      entries: Number(row?.entries ?? '0'),
    };
  }
}

function toCursor(row: WalletLedgerEntryRow): LedgerCursor {
  return { createdAt: row.createdAt, id: row.id };
}
