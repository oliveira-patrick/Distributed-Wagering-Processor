import { FailureCode } from '../../domain/shared/failure-code';
import type { Wallet } from '../../domain/wallet/wallet';
import {
  decodeLedgerCursor,
  encodeLedgerCursor,
} from '../contracts/ledger-cursor';
import type { LedgerPage } from '../ports/wallet-ledger.repository';
import type { UnitOfWork } from '../ports/unit-of-work';
import { refused } from './refusal';
import type { Refusal } from './refusal';

export type GetWalletResult =
  { readonly outcome: 'found'; readonly wallet: Wallet } | Refusal;

export interface LedgerPageQuery {
  readonly walletId: string;
  readonly cursor: string | undefined;
  readonly limit: number;
}

export type GetWalletLedgerResult =
  | {
      readonly outcome: 'found';
      readonly page: LedgerPage;
      // Cursor opaco da próxima página, ausente quando esta é a última.
      readonly nextCursor: string | undefined;
    }
  | Refusal;

// `GET /wallets/:walletId`.
export class GetWalletUseCase {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  async execute(walletId: string): Promise<GetWalletResult> {
    return this.unitOfWork.run(async (repositories) => {
      const wallet = await repositories.wallets.findById(walletId);

      return wallet === undefined
        ? refused(FailureCode.WALLET_NOT_FOUND, `wallet ${walletId} não existe`)
        : { outcome: 'found', wallet };
    });
  }
}

/*
  `GET /wallets/:walletId/ledger?cursor=...&limit=50`.

  A wallet é verificada antes do extrato: extrato vazio de wallet inexistente
  e extrato vazio de wallet recém-aberta são coisas diferentes, e responder
  `200 []` para as duas esconderia um erro de integração.
*/
export class GetWalletLedgerUseCase {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  async execute(query: LedgerPageQuery): Promise<GetWalletLedgerResult> {
    const after =
      query.cursor === undefined ? undefined : decodeLedgerCursor(query.cursor);

    if (query.cursor !== undefined && after === undefined) {
      return refused(
        FailureCode.VALIDATION_FAILED,
        'cursor inválido: use exatamente o valor devolvido pela página anterior',
      );
    }

    return this.unitOfWork.run(async (repositories) => {
      const wallet = await repositories.wallets.findById(query.walletId);
      if (wallet === undefined) {
        return refused(
          FailureCode.WALLET_NOT_FOUND,
          `wallet ${query.walletId} não existe`,
        );
      }

      const page = await repositories.ledger.pageByWallet(query.walletId, {
        after,
        limit: query.limit,
      });

      return {
        outcome: 'found',
        page,
        nextCursor:
          page.nextCursor === undefined
            ? undefined
            : encodeLedgerCursor(page.nextCursor),
      };
    });
  }
}
