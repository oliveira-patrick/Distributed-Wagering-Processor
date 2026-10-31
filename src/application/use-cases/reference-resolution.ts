import { FailureCode } from '../../domain/shared/failure-code';
import { InvariantViolationError } from '../../domain/shared/invariant-violation-error';
import type { WagerTransaction } from '../../domain/wagering/wager-transaction';
import { canReverse } from '../../domain/wagering/wager-transaction-kind';
import { WagerTransactionStatus } from '../../domain/wagering/wager-transaction-status';
import type { Repositories } from '../ports/unit-of-work';

export type ReferenceResolution =
  // A referência existe, é revertível e confere.
  | { readonly kind: 'resolved'; readonly reference: WagerTransaction }
  // Ainda não apareceu, ou apareceu e ainda não terminou: esperar.
  | { readonly kind: 'absent'; readonly reason: string }
  // Apareceu e não serve. Terminal.
  | {
      readonly kind: 'rejected';
      readonly failureCode: FailureCode;
      readonly detail: string;
    };

/*
  Resolve a referência de um `REFUND` ou `ROLLBACK`.

  Três regras precisam valer: a referência pertence ao mesmo contexto, o seu
  tipo admite esta reversão, e o valor é igual. A busca é por
  `(providerId, referenceExternalTransactionId)`, que é a chave natural e já
  garante o mesmo provider; player, wallet, moeda e rodada são conferidos
  aqui.
*/
export async function resolveReference(
  repositories: Repositories,
  transaction: WagerTransaction,
): Promise<ReferenceResolution> {
  const externalId = transaction.referenceExternalTransactionId;

  if (externalId === undefined) {
    throw new InvariantViolationError(
      `${transaction.kind} chegou à resolução de referência sem referência; ` +
        'o contrato de entrada deveria ter recusado',
    );
  }

  const reference = await repositories.transactions.findByProviderAndExternalId(
    transaction.providerId,
    externalId,
  );

  if (reference === undefined) {
    return {
      kind: 'absent',
      reason: `referência ${externalId} não encontrada`,
    };
  }

  // Regra 2. O provider já veio casado pela chave de busca.
  if (
    reference.playerId !== transaction.playerId ||
    reference.walletId !== transaction.walletId ||
    reference.roundId !== transaction.roundId ||
    reference.money.currency !== transaction.money.currency
  ) {
    return {
      kind: 'rejected',
      failureCode: FailureCode.REFERENCE_MISMATCH,
      detail:
        `a referência ${externalId} pertence a outro player, wallet, ` +
        'rodada ou moeda',
    };
  }

  /*
    Estado da referência.

    Aceita mas ainda não aplicada volta como ausente, de propósito: ela pode
    virar `PROCESSED`, e desistir agora recusaria uma reversão legítima por
    acidente de temporização.

    Já `REJECTED` e `FAILED` não aplicaram efeito nenhum e nunca vão aplicar,
    então não há o que reverter. Isso é `REFERENCE_MISMATCH`, cujo sentido
    documentado é "a referência existe e não corresponde a uma transação
    revertível" — divergência de identidade **ou** de estado. Interpretação
    adicional, declarada.
  */
  if (
    reference.status === WagerTransactionStatus.Pending ||
    reference.status === WagerTransactionStatus.PendingReference
  ) {
    return {
      kind: 'absent',
      reason: `referência ${externalId} ainda em ${reference.status}`,
    };
  }

  if (reference.status !== WagerTransactionStatus.Processed) {
    return {
      kind: 'rejected',
      failureCode: FailureCode.REFERENCE_MISMATCH,
      detail:
        `a referência ${externalId} está em ${reference.status} e não ` +
        'aplicou efeito algum',
    };
  }

  // Regra 3.
  if (!canReverse(transaction.kind, reference.kind)) {
    return {
      kind: 'rejected',
      failureCode: FailureCode.REFERENCE_KIND_INVALID,
      detail: `${transaction.kind} não reverte ${reference.kind}`,
    };
  }

  // Regra 5. Reversão parcial está fora de escopo.
  if (!reference.money.equals(transaction.money)) {
    return {
      kind: 'rejected',
      failureCode: FailureCode.AMOUNT_MISMATCH,
      detail:
        `o valor ${transaction.money.toString()} difere do valor da ` +
        `referência, ${reference.money.toString()}`,
    };
  }

  return { kind: 'resolved', reference };
}
