import type { Money } from '../money/money';
import { canonicalJson, sha256Hex } from '../shared/canonical-json';
import type { WagerTransactionKind } from './wager-transaction-kind';

/*
  Campos de negócio de uma submissão de transação.

  É o subconjunto que entra no `payloadHash`. Fora dele ficam, de propósito:

  - O header `Idempotency-Key`, que é a **chave** e não o conteúdo — incluí-lo no hash seria circular;
  - Metadados de transporte (`messageId`, `type`, `occurredAt`), que variam
    entre reentregas da mesma operação e tornariam todo redelivery um conflito.
  - O `idempotencyKey` que vem dentro de `data` na mensagem SQS, pelo mesmo motivo do header.
*/
export interface WagerPayloadFields {
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly money: Money;
  readonly referenceExternalTransactionId: string | undefined;
}

/*
  `payloadHash` = SHA-256 do JSON canônico dos campos de negócio.

  O algoritmo, documentado porque o provedor precisa poder reproduzi-lo:

  1. os nove campos de `WagerPayloadFields` são coletados, e nada mais;
  2. `money` é **normalizado** antes de entrar — `Money.toJSON()` produz
     `{ amount, currency }` com escala 2 fixa;
  3. chaves com valor `undefined` são omitidas;
  4. o objeto é serializado com chaves ordenadas por code point, sem espaços;
  5. SHA-256 em hexadecimal minúsculo.

  O passo 2 é o que mais importa na prática. Sem normalizar, um provedor que
  reenvia `"25"` onde antes mandou `"25.00"` — mesma operação, mesma
  intenção, formatação diferente — receberia `IDEMPOTENCY_CONFLICT` em vez de
  replay. Hashear o valor de domínio em vez do texto cru faz o conflito
  significar o que deve significar: **mudou o negócio**, não mudou a formatação.
*/
export function hashWagerPayload(fields: WagerPayloadFields): string {
  return sha256Hex(
    canonicalJson({
      providerId: fields.providerId,
      externalTransactionId: fields.externalTransactionId,
      playerId: fields.playerId,
      walletId: fields.walletId,
      roundId: fields.roundId,
      gameId: fields.gameId,
      kind: fields.kind,
      money: fields.money.toJSON(),
      referenceExternalTransactionId: fields.referenceExternalTransactionId,
    }),
  );
}
