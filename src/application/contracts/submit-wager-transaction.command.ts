import { z } from 'zod';

import {
  WagerTransactionKind,
  isSubmittableKind,
  requiresReference,
} from '../../domain/wagering/wager-transaction-kind';
import { EXTERNAL_ID_MAX_LENGTH } from './create-wallet.command';
import { operationMoneySchema } from './money.schema';

/*
  Tipos que um provedor pode submeter.

  `OPENING` fica de fora: ele é interno, criado pela abertura de wallet. O
  construtor do domínio o aceita de propósito — ele não sabe de onde veio a
  chamada —, e é **este** contrato que o recusa.
*/
const SUBMITTABLE_KINDS =
  Object.values(WagerTransactionKind).filter(isSubmittableKind);

/*
  A forma do payload, sem o refinamento.

  Exportada separada porque a entrada pela fila é **este mesmo payload mais o
  `idempotencyKey`** — que no HTTP vem em header —, e estender um schema já
  refinado não é possível. Com a forma crua e o refinamento à parte, os dois
  contratos compartilham campo por campo em vez de se repetirem. Ver o
  `wager-message.schema.ts`.
*/
export const submitWagerTransactionObject = z.object({
  providerId: z.string().min(1).max(EXTERNAL_ID_MAX_LENGTH),
  externalTransactionId: z.string().min(1).max(EXTERNAL_ID_MAX_LENGTH),
  playerId: z.string().min(1).max(EXTERNAL_ID_MAX_LENGTH),
  walletId: z.uuid(),
  roundId: z.string().min(1).max(EXTERNAL_ID_MAX_LENGTH),
  gameId: z.string().min(1).max(EXTERNAL_ID_MAX_LENGTH),
  kind: z.enum(SUBMITTABLE_KINDS),
  money: operationMoneySchema,
  referenceExternalTransactionId: z
    .string()
    .min(1)
    .max(EXTERNAL_ID_MAX_LENGTH)
    .optional(),
});

/*
  `REFUND` e `ROLLBACK` exigem referência.

  Recusada aqui, e não no construtor do agregado, porque payload incompleto é
  erro de requisição — 400 — e não violação de invariante, que viraria 500.
  Vale para as duas portas de entrada, e por isso é função nomeada em vez de
  um `superRefine` embutido num schema só.
*/
export function requireReferenceWhenKindDemands(
  value: {
    readonly kind: WagerTransactionKind;
    /*
      `| undefined` explícito por causa de `exactOptionalPropertyTypes`: sem
      ele, a propriedade opcional do schema não casa com este parâmetro.
    */
    readonly referenceExternalTransactionId?: string | undefined;
  },
  ctx: z.RefinementCtx,
): void {
  if (
    requiresReference(value.kind) &&
    value.referenceExternalTransactionId === undefined
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['referenceExternalTransactionId'],
      message: `${value.kind} exige referenceExternalTransactionId`,
    });
  }
}

/*
  Entrada de `POST /wagering/transactions`, sem o header.

  O `Idempotency-Key` não entra aqui: ele é obrigatório, mas é transporte, e
  header e metadado de transporte **não** entram no hash de payload. Manter o
  corpo separado do header é o que garante isso por construção — o hash é
  calculado a partir deste objeto.
*/
export const submitWagerTransactionSchema =
  submitWagerTransactionObject.superRefine(requireReferenceWhenKindDemands);

export type SubmitWagerTransactionPayload = z.infer<
  typeof submitWagerTransactionSchema
>;

/*
  O que o caso de uso recebe: o payload de negócio mais o que vem do
  transporte.
*/
export interface SubmitWagerTransactionInput {
  // Fonte da verdade da idempotência.
  readonly idempotencyKey: string;
  readonly correlationId: string;
  readonly payload: SubmitWagerTransactionPayload;
  /*
    Credencial que o transporte trouxe: o header `Authorization` no HTTP,
    ausente quando a entrada é a fila. Vai para o `ProviderIdentityPort`.
  */
  readonly credential?: string | undefined;
}
