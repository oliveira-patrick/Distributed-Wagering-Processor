import { randomUUID } from 'node:crypto';

import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Headers,
  Param,
  Post,
  Query,
} from '@nestjs/common';

import { createWalletSchema } from '../../application/contracts/create-wallet.command';
import type { CreateWalletCommand } from '../../application/contracts/create-wallet.command';
import { ledgerQuerySchema } from '../../application/contracts/ledger-query.schema';
import type { LedgerQuery } from '../../application/contracts/ledger-query.schema';
import { CreateWalletUseCase } from '../../application/use-cases/create-wallet.use-case';
import { ReconcileWalletUseCase } from '../../application/use-cases/reconcile-wallet.use-case';
import {
  GetWalletLedgerUseCase,
  GetWalletUseCase,
} from '../../application/use-cases/wallet-queries.use-case';
import { FailureException } from './failure.exception';
import {
  presentLedgerPage,
  presentReconciliation,
  presentWallet,
} from './presenters/wallet.presenter';
import type {
  LedgerPageResponse,
  ReconciliationResponse,
  WalletResponse,
} from './presenters/wallet.presenter';
import { ZodPipe } from './zod.pipe';

/*
  Os quatro endpoints de wallet.

  Nenhum exige autenticação, pela decisão registrada no `ARCHITECTURE.md` e
  registrada no `ARCHITECTURE.md`. O ponto de extensão é o
  `ProviderIdentityPort`, consumido pela submissão de transação.

  Recusa vira exceção HTTP e sucesso vira corpo. A tradução de `failureCode`
  para status está num mapa total em `failure-http.ts`, compartilhado por
  todos os endpoints — é o que garante a consistência entre eles.
*/
@Controller()
export class WalletsController {
  constructor(
    private readonly createWallet: CreateWalletUseCase,
    private readonly getWallet: GetWalletUseCase,
    private readonly getLedger: GetWalletLedgerUseCase,
    private readonly reconcile: ReconcileWalletUseCase,
  ) {}

  @Post('wallets')
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body(new ZodPipe(createWalletSchema)) command: CreateWalletCommand,
    @Headers('x-correlation-id') correlationId: string | undefined,
  ): Promise<WalletResponse> {
    const result = await this.createWallet.execute(
      command,
      correlationId ?? randomUUID(),
    );

    if (result.outcome === 'refused') {
      throw new FailureException(result.failureCode, result.detail);
    }

    return presentWallet(result.wallet);
  }

  @Get('wallets/:walletId')
  async byId(@Param('walletId') walletId: string): Promise<WalletResponse> {
    const result = await this.getWallet.execute(walletId);

    if (result.outcome === 'refused') {
      throw new FailureException(result.failureCode, result.detail);
    }

    return presentWallet(result.wallet);
  }

  @Get('wallets/:walletId/ledger')
  async ledger(
    @Param('walletId') walletId: string,
    @Query(new ZodPipe(ledgerQuerySchema)) query: LedgerQuery,
  ): Promise<LedgerPageResponse> {
    const result = await this.getLedger.execute({
      walletId,
      cursor: query.cursor,
      limit: query.limit,
    });

    if (result.outcome === 'refused') {
      throw new FailureException(result.failureCode, result.detail);
    }

    return presentLedgerPage(result.page.entries, result.nextCursor);
  }

  /*
    `POST`, e não `GET`.

    Faz sentido: a reconciliação toma lock na wallet e registra o resultado
    quando divergente, então não é uma leitura sem efeito.
  */
  @Post('wallets/:walletId/reconciliation')
  @HttpCode(HttpStatus.OK)
  async reconciliation(
    @Param('walletId') walletId: string,
  ): Promise<ReconciliationResponse> {
    const result = await this.reconcile.execute(walletId);

    if (result.outcome === 'refused') {
      throw new FailureException(result.failureCode, result.detail);
    }

    return presentReconciliation(result.report);
  }
}
