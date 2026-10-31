import { FailureCode } from '../../domain/shared/failure-code';
import type { WagerTransaction } from '../../domain/wagering/wager-transaction';
import type { UnitOfWork } from '../ports/unit-of-work';
import { refused } from './refusal';
import type { Refusal } from './refusal';

export type GetWagerTransactionResult =
  | { readonly outcome: 'found'; readonly transaction: WagerTransaction }
  | Refusal;

/*
  As duas consultas de transação: por id interno e pela chave do provedor.

  Numa classe só porque são a mesma pergunta por dois caminhos: o id interno,
  que a plataforma devolveu, e a chave natural `(providerId,
  externalTransactionId)`, que é a que o provedor conhece. Um provedor que
  perdeu a resposta de um `POST` consegue descobrir o que aconteceu pela
  segunda — é o que torna a API recuperável sem depender de o cliente ter
  guardado o id.
*/
export class GetWagerTransactionUseCase {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  async byId(transactionId: string): Promise<GetWagerTransactionResult> {
    return this.unitOfWork.run(async (repositories) => {
      const transaction =
        await repositories.transactions.findById(transactionId);

      return transaction === undefined
        ? refused(
            FailureCode.TRANSACTION_NOT_FOUND,
            `transação ${transactionId} não existe`,
          )
        : { outcome: 'found', transaction };
    });
  }

  async byProviderAndExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<GetWagerTransactionResult> {
    return this.unitOfWork.run(async (repositories) => {
      const transaction =
        await repositories.transactions.findByProviderAndExternalId(
          providerId,
          externalTransactionId,
        );

      return transaction === undefined
        ? refused(
            FailureCode.TRANSACTION_NOT_FOUND,
            `o provedor ${providerId} não tem a transação ` +
              externalTransactionId,
          )
        : { outcome: 'found', transaction };
    });
  }
}
