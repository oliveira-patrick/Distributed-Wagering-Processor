import type { Money } from '../../domain/money/money';
import { FailureCode } from '../../domain/shared/failure-code';
import type { LoggerPort } from '../ports/logger.port';
import type { UnitOfWork } from '../ports/unit-of-work';
import { refused } from './refusal';
import type { Refusal } from './refusal';

export interface ReconciliationReport {
  readonly walletId: string;
  // O saldo materializado na wallet.
  readonly storedBalance: Money;
  // O saldo reconstruído somando o ledger, dentro do PostgreSQL.
  readonly calculatedBalance: Money;
  // `stored − calculated`. Zero quando conferem.
  readonly difference: Money;
  readonly consistent: boolean;
  readonly checkedEntries: number;
}

export type ReconcileWalletResult =
  | { readonly outcome: 'checked'; readonly report: ReconciliationReport }
  | Refusal;

/*
  `POST /wallets/:walletId/reconciliation`.

  **Divergência não é corrigida.** Ela é logada, contabilizada em métrica e
  sinalizada na resposta, nunca corrigida em silêncio. A razão é que uma
  correção automática destrói a evidência do bug que a causou — e num ledger
  a evidência vale mais que o número bonito. Se saldo e ledger divergem,
  alguém escreveu num deles sem escrever no outro, e isso é defeito a
  investigar.

  A wallet é carregada **sob lock** mesmo sendo uma leitura, e isso é
  necessário: em `READ COMMITTED`, dois `select` na mesma transação podem ver
  instantes diferentes. Sem o lock, a reconciliação poderia ler o saldo antes
  de uma aposta e o ledger depois dela, e **inventar** uma divergência que não
  existe. O lock serializa contra quem escreve nessa wallet, e como o escritor
  grava saldo e lançamento no mesmo commit, o par lido é coerente.
*/
export class ReconcileWalletUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly logger: LoggerPort,
  ) {}

  async execute(walletId: string): Promise<ReconcileWalletResult> {
    const result = await this.unitOfWork.run(
      async (repositories): Promise<ReconcileWalletResult> => {
        const wallet = await repositories.wallets.findByIdForUpdate(walletId);
        if (wallet === undefined) {
          return refused(
            FailureCode.WALLET_NOT_FOUND,
            `wallet ${walletId} não existe`,
          );
        }

        const totals = await repositories.ledger.totalsByWallet(
          walletId,
          wallet.currency,
        );
        const difference = wallet.balance.subtract(totals.balance);

        return {
          outcome: 'checked',
          report: {
            walletId,
            storedBalance: wallet.balance,
            calculatedBalance: totals.balance,
            difference,
            consistent: difference.isZero(),
            checkedEntries: totals.entries,
          },
        };
      },
    );

    if (result.outcome === 'checked' && !result.report.consistent) {
      /*
        Fora da transação de propósito: o log precisa sair mesmo que o commit
        falhe depois, porque a divergência foi observada de qualquer forma.
        Sem valores monetários na mensagem: payload financeiro não entra no
        log, e o relatório na resposta já carrega os números.
      */
      this.logger.warn('reconciliação divergente', {
        walletId,
        checkedEntries: result.report.checkedEntries,
      });
    }

    return result;
  }
}
