/*
  Estado de uma transação de aposta.

  As transições válidas são definidas e documentadas aqui, e `PROCESSED`,
  `REJECTED` e `FAILED` são terminais.
*/
export const WagerTransactionStatus = {
  // Aceita, ainda não aplicada.
  Pending: 'PENDING',
  // Aguardando a transação referenciada aparecer.
  PendingReference: 'PENDING_REFERENCE',
  // Aplicada. Terminal.
  Processed: 'PROCESSED',
  // Recusada por regra de negócio. Terminal.
  Rejected: 'REJECTED',
  // Erro permanente de infraestrutura. Terminal e auditável.
  Failed: 'FAILED',
} as const;

export type WagerTransactionStatus =
  (typeof WagerTransactionStatus)[keyof typeof WagerTransactionStatus];

/*
  Transições válidas.

  ```mermaid
  stateDiagram-v2
    [*] --> PENDING
    PENDING --> PROCESSED
    PENDING --> PENDING_REFERENCE
    PENDING --> REJECTED
    PENDING --> FAILED
    PENDING_REFERENCE --> PROCESSED
    PENDING_REFERENCE --> REJECTED
    PENDING_REFERENCE --> FAILED
    PROCESSED --> [*]
    REJECTED --> [*]
    FAILED --> [*]
  ```

  `PENDING_REFERENCE` não volta para `PENDING`: a transação já foi aceita, e
  o que falta é a referência — reprocessar não a torna menos aceita. E
  nenhum estado terminal tem saída, de modo que tentar transicionar a partir
  de um deles é erro de programação, não caminho de negócio.
*/
const ALLOWED_TRANSITIONS: Readonly<
  Record<WagerTransactionStatus, readonly WagerTransactionStatus[]>
> = {
  [WagerTransactionStatus.Pending]: [
    WagerTransactionStatus.Processed,
    WagerTransactionStatus.PendingReference,
    WagerTransactionStatus.Rejected,
    WagerTransactionStatus.Failed,
  ],
  [WagerTransactionStatus.PendingReference]: [
    WagerTransactionStatus.Processed,
    WagerTransactionStatus.Rejected,
    WagerTransactionStatus.Failed,
  ],
  [WagerTransactionStatus.Processed]: [],
  [WagerTransactionStatus.Rejected]: [],
  [WagerTransactionStatus.Failed]: [],
};

const TERMINAL: readonly WagerTransactionStatus[] = [
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
];

export function isTerminalStatus(status: WagerTransactionStatus): boolean {
  return TERMINAL.includes(status);
}

export function canTransition(
  from: WagerTransactionStatus,
  to: WagerTransactionStatus,
): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}
