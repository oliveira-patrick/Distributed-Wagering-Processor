/*
  Taxonomia de códigos de falha.

  Toda rejeição carrega um código estável e legível por máquina, suficiente
  para o provedor decidir entre reenviar, corrigir o payload ou desistir.
  Esta é a taxonomia, e o `ARCHITECTURE.md` traz a tabela completa com o
  status HTTP de cada código.

  A fronteira que organiza a lista é a pergunta que o provedor faz: "a culpa
  é do meu payload, da regra de negócio, ou do transporte?". Códigos que
  respondem a mesma pergunta se parecem; códigos que pedem reações
  diferentes nunca são colapsados num só. É por isso que
  `REVERSAL_WOULD_OVERDRAW` existe separado de `INSUFFICIENT_FUNDS`: a
  segunda é rotina de aposta, e a primeira indica que provedor e plataforma
  divergem sobre o estado — situação que pede investigação, não reenvio.
*/
export const FailureCode = {
  // Payload malformado ou fora do contrato de entrada.
  VALIDATION_FAILED: 'VALIDATION_FAILED',

  // Mesma idempotency key com payload divergente. Não é replay.
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',

  // Já existe wallet para o par `playerId` + `currency`.
  WALLET_ALREADY_EXISTS: 'WALLET_ALREADY_EXISTS',

  WALLET_NOT_FOUND: 'WALLET_NOT_FOUND',
  TRANSACTION_NOT_FOUND: 'TRANSACTION_NOT_FOUND',

  // A moeda da operação difere da moeda da wallet.
  CURRENCY_MISMATCH: 'CURRENCY_MISMATCH',

  // `BET` sem saldo suficiente. Rotina.
  INSUFFICIENT_FUNDS: 'INSUFFICIENT_FUNDS',

  /*
    A reversão deixaria o saldo negativo — acontece ao reverter um `WIN`,
    cujo lançamento invertido é um débito. Separado de
    `INSUFFICIENT_FUNDS` por decisão explícita: as duas situações pedem
    reações diferentes do provedor.
  */
  REVERSAL_WOULD_OVERDRAW: 'REVERSAL_WOULD_OVERDRAW',

  // A referência não apareceu dentro do prazo de reprocessamento.
  REFERENCE_NOT_FOUND: 'REFERENCE_NOT_FOUND',

  // A referência existe, mas é de outro provider, player, wallet, moeda ou rodada.
  REFERENCE_MISMATCH: 'REFERENCE_MISMATCH',

  /*
    A referência existe e pertence ao mesmo contexto, mas o seu `kind` não
    admite esta reversão — `REFUND` só reverte `BET`, e `ROLLBACK` reverte
    `BET`, `WIN` ou `REFUND`. Distinto de
    `REFERENCE_MISMATCH`, que é divergência de identidade, não de tipo.
  */
  REFERENCE_KIND_INVALID: 'REFERENCE_KIND_INVALID',

  // A referência já foi revertida por uma operação do mesmo tipo.
  ALREADY_REVERSED: 'ALREADY_REVERSED',

  // O valor da reversão difere do valor da referência.
  AMOUNT_MISMATCH: 'AMOUNT_MISMATCH',

  // PostgreSQL ou SQS indisponível. Transitório: reenviar faz sentido.
  TRANSPORT_UNAVAILABLE: 'TRANSPORT_UNAVAILABLE',
} as const;

export type FailureCode = (typeof FailureCode)[keyof typeof FailureCode];
