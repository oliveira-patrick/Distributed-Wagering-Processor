import type { IntegrationEvent } from '../../domain/messaging/integration-event';
import type { EventContext } from '../../domain/messaging/integration-event';
import { OutboxMessage } from '../../domain/messaging/outbox-message';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../../domain/messaging/events';
import type { Money } from '../../domain/money/money';
import { FailureCode } from '../../domain/shared/failure-code';
import { InvariantViolationError } from '../../domain/shared/invariant-violation-error';
import {
  referenceAttemptsExhausted,
  referenceRetryDelayMs,
} from '../../domain/wagering/reference-retry';
import { hashWagerPayload } from '../../domain/wagering/wager-payload-hash';
import { WagerTransaction } from '../../domain/wagering/wager-transaction';
import { LedgerDirection } from '../../domain/wallet/ledger-direction';
import type { Wallet } from '../../domain/wallet/wallet';
import type { SubmitWagerTransactionInput } from '../contracts/submit-wager-transaction.command';
import type { ProviderIdentityPort } from '../ports/provider-identity.port';
import type { Clock, IdGenerator } from '../ports/system.port';
import type { Repositories, UnitOfWork } from '../ports/unit-of-work';
import { TransactionConflict } from '../ports/wager-transaction.repository';
import type { TransactionInsertOutcome } from '../ports/wager-transaction.repository';
import { resolveReference } from './reference-resolution';
import { refused } from './refusal';
import type { Refusal } from './refusal';

export type SubmitWagerTransactionResult =
  | {
      readonly outcome: 'recorded';
      readonly transaction: WagerTransaction;
      // Saldo a devolver: o observado na transação, ou o atual da wallet.
      readonly balance: Money;
      readonly idempotentReplay: boolean;
    }
  | Refusal;

/*
  O resultado de `prepare`: ou a submissão foi recusada antes de encostar no
  banco, ou o hash do payload está pronto para o corpo transacional.
*/
export type PreparedSubmission =
  { readonly outcome: 'prepared'; readonly payloadHash: string } | Refusal;

/*
  `POST /wagering/transactions` — o caminho central do sistema.

  A ordem dos passos **é** a corretude, e cada um existe por uma razão:

  1. identidade do provedor, quando o canal a traz;
  2. hash do payload de negócio, sem header nem metadado de transporte;
  3. wallet carregada **sob lock de linha** — a arbitragem de concorrência é
     do PostgreSQL, por `walletId`, e nunca um lock global;
  4. transação **inserida antes** de qualquer consulta de duplicidade: quem
     decide o vencedor é a unicidade no schema, não um `select` que duas
     instâncias atravessam juntas;
  5. referência resolvida — mesmo contexto, tipo revertível, valor igual;
  6. efeito, lançamento e evento no **mesmo commit**.

  Carregar a wallet antes de inserir é deliberado. A foreign key composta
  `(wallet_id, currency)` torna irrepresentável uma transação para wallet
  inexistente ou em moeda divergente, então inserir primeiro produziria
  violação de chave estrangeira — erro de infraestrutura — onde o provedor
  precisa de `WALLET_NOT_FOUND` ou `CURRENCY_MISMATCH`. E não enfraquece a
  idempotência: a inserção continua sendo quem decide entre duas tentativas
  concorrentes.
*/
export class SubmitWagerTransactionUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly identity: ProviderIdentityPort,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  /*
    O caminho HTTP: prepara, abre a transação e aplica.

    Está dividido em `prepare` e `executeWithin` por uma necessidade
    concreta, não por gosto: o consumidor da fila precisa reusar **este**
    caso de uso e, ao mesmo tempo, gravar o inbox no **mesmo commit** do
    efeito financeiro. Com a transação aberta aqui
    dentro, o consumidor não conseguiria as duas coisas: ou duplicaria a
    lógica, ou gravaria o inbox numa transação à parte — e aí uma queda entre
    os dois commits reprocessaria a operação. Ver ADR-011.
  */
  async execute(
    input: SubmitWagerTransactionInput,
  ): Promise<SubmitWagerTransactionResult> {
    const prepared = await this.prepare(input);

    if (prepared.outcome === 'refused') {
      return prepared;
    }

    return this.unitOfWork.run((repositories) =>
      this.executeWithin(repositories, input, prepared.payloadHash),
    );
  }

  /*
    O que acontece **fora** da transação: identidade e hash do payload.

    Fora de propósito. Resolver a identidade é E/S — num provedor de verdade,
    uma consulta de JWKS e manter uma transação SQL aberta durante ela
    seguraria o lock da wallet pelo tempo de uma chamada de rede alheia. O
    hash é puro e sai junto porque é a outra coisa que não depende do banco.
  */
  async prepare(
    input: SubmitWagerTransactionInput,
  ): Promise<PreparedSubmission> {
    const payload = input.payload;

    const authorization = await this.identity.resolve(input.credential);
    if (
      authorization.authenticated &&
      authorization.providerId !== payload.providerId
    ) {
      return refused(
        FailureCode.VALIDATION_FAILED,
        `a identidade autenticada (${authorization.providerId}) não ` +
          `corresponde ao providerId do payload (${payload.providerId})`,
      );
    }

    return {
      outcome: 'prepared',
      payloadHash: hashWagerPayload({
        providerId: payload.providerId,
        externalTransactionId: payload.externalTransactionId,
        playerId: payload.playerId,
        walletId: payload.walletId,
        roundId: payload.roundId,
        gameId: payload.gameId,
        kind: payload.kind,
        money: payload.money,
        referenceExternalTransactionId: payload.referenceExternalTransactionId,
      }),
    };
  }

  /*
    O corpo transacional, sobre repositórios que **já** estão numa transação.

    É o ponto de reuso do consumidor da fila e do worker de referência: eles
    abrem a transação, gravam o que lhes cabe — o inbox, no caso do
    consumidor — e chamam este método, de modo que tudo caia num commit só.

    Não abre transação e não deve abrir: quem chama é dono da fronteira.
  */
  async executeWithin(
    repositories: Repositories,
    input: SubmitWagerTransactionInput,
    payloadHash: string,
  ): Promise<SubmitWagerTransactionResult> {
    const payload = input.payload;
    const now = this.clock.now();

    const wallet = await repositories.wallets.findByIdForUpdate(
      payload.walletId,
    );
    if (wallet === undefined) {
      return refused(
        FailureCode.WALLET_NOT_FOUND,
        `wallet ${payload.walletId} não existe`,
      );
    }
    if (wallet.playerId !== payload.playerId) {
      return refused(
        FailureCode.VALIDATION_FAILED,
        `a wallet ${wallet.id} não pertence ao player ${payload.playerId}`,
      );
    }
    if (wallet.currency !== payload.money.currency) {
      return refused(
        FailureCode.CURRENCY_MISMATCH,
        `a wallet ${wallet.id} é em ${wallet.currency}, e a operação em ` +
          payload.money.currency,
      );
    }

    const transaction = WagerTransaction.create({
      id: this.ids.next(),
      providerId: payload.providerId,
      externalTransactionId: payload.externalTransactionId,
      idempotencyKey: input.idempotencyKey,
      payloadHash,
      walletId: payload.walletId,
      playerId: payload.playerId,
      roundId: payload.roundId,
      gameId: payload.gameId,
      kind: payload.kind,
      money: payload.money,
      referenceExternalTransactionId: payload.referenceExternalTransactionId,
      createdAt: now,
    });

    const insertion = await repositories.transactions.tryInsert(transaction);

    if (!insertion.inserted) {
      return this.onConflict(
        repositories,
        insertion,
        input,
        payloadHash,
        wallet,
        transaction,
        now,
      );
    }

    return this.resolveAndApply(
      repositories,
      transaction,
      wallet,
      now,
      input.correlationId,
    );
  }

  /*
    Reavalia uma transação em `PENDING_REFERENCE`.

    Vive aqui, e não no worker, porque é esta classe que sabe o que fazer com
    uma transação e a sua referência: aplicar o efeito, recusar, ou continuar
    esperando. O worker é a agenda; a regra é a mesma do caminho de
    submissão, e duplicá-la lá abriria espaço para as duas divergirem.

    Como `executeWithin`, **não** abre transação: quem chama é dono da
    fronteira. E, como ele, carrega a wallet sob lock antes de qualquer
    decisão — o efeito tardio disputa o mesmo saldo que a API, e a ordem
    "lock da wallet primeiro" é a mesma nos dois caminhos justamente para
    não haver deadlock entre eles.
  */
  async retryReferenceWithin(
    repositories: Repositories,
    transaction: WagerTransaction,
    correlationId: string,
  ): Promise<SubmitWagerTransactionResult> {
    const now = this.clock.now();

    const wallet = await repositories.wallets.findByIdForUpdate(
      transaction.walletId,
    );

    if (wallet === undefined) {
      /*
        A foreign key composta torna isto irrepresentável; se acontecer, é
        corrupção de dados e não um caminho de negócio.
      */
      throw new InvariantViolationError(
        `a transação ${transaction.id} aponta para a wallet ` +
          `${transaction.walletId}, que não existe`,
      );
    }

    const resolution = await resolveReference(repositories, transaction);

    switch (resolution.kind) {
      case 'resolved':
        return this.applyEffect(
          repositories,
          transaction,
          wallet,
          resolution.reference,
          now,
          correlationId,
        );

      case 'rejected':
        return this.rejectInserted(
          repositories,
          transaction,
          resolution.failureCode,
          now,
          wallet,
          correlationId,
        );

      case 'absent':
        return this.keepWaiting(
          repositories,
          transaction,
          wallet,
          now,
          correlationId,
        );
    }
  }

  /*
    A referência ainda não apareceu. Ou espera mais, ou desiste.

    `referenceAttempts` conta a submissão como a primeira tentativa, então a
    execução atual é a de número `attempts + 1`. Esgotado o limite, a
    transação vira `REJECTED` com `REFERENCE_NOT_FOUND` e o evento sai. É o
    que impede uma transação de ficar pendurada para sempre.
  */
  private async keepWaiting(
    repositories: Repositories,
    transaction: WagerTransaction,
    wallet: Wallet,
    now: Date,
    correlationId: string,
  ): Promise<SubmitWagerTransactionResult> {
    const attemptsSoFar = transaction.referenceAttempts + 1;

    if (referenceAttemptsExhausted(attemptsSoFar)) {
      return this.rejectInserted(
        repositories,
        transaction,
        FailureCode.REFERENCE_NOT_FOUND,
        now,
        wallet,
        correlationId,
      );
    }

    transaction.rescheduleReference(
      new Date(now.getTime() + referenceRetryDelayMs(attemptsSoFar)),
    );
    await repositories.transactions.save(transaction);

    return this.recorded(transaction, wallet.balance);
  }

  // A unicidade no schema recusou a inserção. Cada colisão tem um sentido.
  private async onConflict(
    repositories: Repositories,
    insertion: Extract<TransactionInsertOutcome, { inserted: false }>,
    input: SubmitWagerTransactionInput,
    payloadHash: string,
    wallet: Wallet,
    attempted: WagerTransaction,
    now: Date,
  ): Promise<SubmitWagerTransactionResult> {
    switch (insertion.conflict) {
      case TransactionConflict.IdempotencyKey: {
        const existing = await repositories.transactions.findByIdempotencyKey(
          input.idempotencyKey,
        );

        if (existing === undefined) {
          throw new InvariantViolationError(
            `a unicidade recusou a chave ${input.idempotencyKey}, e nenhuma ` +
              'transação foi encontrada com ela',
          );
        }

        /*
          Mesma chave com payload divergente é conflito, não replay. É o
          hash que distingue as duas coisas.
        */
        if (!existing.matchesPayload(payloadHash)) {
          return refused(
            FailureCode.IDEMPOTENCY_CONFLICT,
            `a chave ${input.idempotencyKey} já foi usada com outro payload`,
          );
        }

        /*
          Devolve o resultado original, incluindo o saldo observado
          naquele momento. Transação ainda pendente não tem saldo
          observado, e aí o saldo corrente é a melhor resposta possível.
        */
        return {
          outcome: 'recorded',
          transaction: existing,
          balance: existing.observedBalance ?? wallet.balance,
          idempotentReplay: true,
        };
      }

      case TransactionConflict.ProviderExternalId:
        /*
          A mesma transação do provedor chegou com outra chave de
          idempotência. Não é replay — a chave é a fonte da verdade e esta é
          outra — nem operação nova, porque o par `(provider, id externo)` já
          existe. Só o provedor pode resolver qual das duas é a verdadeira.
        */
        return refused(
          FailureCode.IDEMPOTENCY_CONFLICT,
          `a transação ${input.payload.externalTransactionId} do provedor ` +
            `${input.payload.providerId} já existe com outra chave de ` +
            'idempotência',
        );

      case TransactionConflict.AlreadyReversed:
        /*
          Uma referência não é revertida duas vezes pelo mesmo tipo de
          operação. O índice parcial que recusou cobre apenas os
          estados vivos, então a transação **cabe** como `REJECTED` — e é o
          que se faz, para que a tentativa fique auditável e gere evento, em
          vez de virar só um código HTTP que o provedor pode nunca ter lido.
        */
        return this.rejectUninserted(
          repositories,
          attempted,
          FailureCode.ALREADY_REVERSED,
          now,
          wallet,
          input.correlationId,
        );
    }
  }

  private async resolveAndApply(
    repositories: Repositories,
    transaction: WagerTransaction,
    wallet: Wallet,
    now: Date,
    correlationId: string,
  ): Promise<SubmitWagerTransactionResult> {
    if (!transaction.requiresReference()) {
      return this.applyEffect(
        repositories,
        transaction,
        wallet,
        await this.linkRoundReference(repositories, transaction),
        now,
        correlationId,
      );
    }

    const resolution = await resolveReference(repositories, transaction);

    switch (resolution.kind) {
      case 'absent':
        return this.schedulePendingReference(
          repositories,
          transaction,
          wallet,
          now,
          correlationId,
        );

      case 'rejected':
        return this.rejectInserted(
          repositories,
          transaction,
          resolution.failureCode,
          now,
          wallet,
          correlationId,
        );

      case 'resolved':
        return this.applyEffect(
          repositories,
          transaction,
          wallet,
          resolution.reference,
          now,
          correlationId,
        );
    }
  }

  /*
    Referência opcional de `WIN` — "pode referenciar a `BET` da mesma rodada".

    Informativa, não normativa: as regras de reversão valem para `REFUND` e
    `ROLLBACK`, não para `WIN`. Se a referência resolve na mesma wallet, o id
    interno é guardado para rastreio; se não resolve, o `WIN` é aplicado de
    todo modo. Recusar um crédito legítimo por causa de um campo opcional que
    não resolveu seria severo demais. Interpretação adicional, declarada.
  */
  private async linkRoundReference(
    repositories: Repositories,
    transaction: WagerTransaction,
  ): Promise<WagerTransaction | undefined> {
    const externalId = transaction.referenceExternalTransactionId;
    if (externalId === undefined) {
      return undefined;
    }

    const reference =
      await repositories.transactions.findByProviderAndExternalId(
        transaction.providerId,
        externalId,
      );

    return reference?.walletId === transaction.walletId ? reference : undefined;
  }

  private async applyEffect(
    repositories: Repositories,
    transaction: WagerTransaction,
    wallet: Wallet,
    reference: WagerTransaction | undefined,
    now: Date,
    correlationId: string,
  ): Promise<SubmitWagerTransactionResult> {
    /*
      `LOSS` registra o resultado sem mover saldo e sem lançamento, e ainda
      assim publica `WagerTransactionProcessed`: ele **é** uma transação
      aplicada. É também a razão de `observedBalance` existir: não
      há `balanceAfter` de lançamento de onde tirar o saldo do replay.
    */
    if (!transaction.affectsBalance()) {
      transaction.markProcessed(reference?.id, now, wallet.balance);
      await repositories.transactions.save(transaction);
      await this.enqueue(
        repositories,
        WagerTransactionProcessed.from(
          transaction,
          this.eventContext(correlationId, now, transaction.id),
        ),
      );
      return this.recorded(transaction, wallet.balance);
    }

    const direction = transaction.ledgerDirectionFor(reference);

    if (
      direction === LedgerDirection.Debit &&
      !wallet.covers(transaction.money)
    ) {
      return this.rejectInserted(
        repositories,
        transaction,
        transaction.requiresReference()
          ? FailureCode.REVERSAL_WOULD_OVERDRAW
          : FailureCode.INSUFFICIENT_FUNDS,
        now,
        wallet,
        correlationId,
      );
    }

    const movement = {
      entryId: this.ids.next(),
      transactionId: transaction.id,
      money: transaction.money,
      now,
    };
    const entry =
      direction === LedgerDirection.Credit
        ? wallet.credit(movement)
        : wallet.debit(movement);

    await repositories.ledger.append(entry);
    await repositories.wallets.save(wallet);

    transaction.markProcessed(reference?.id, now, wallet.balance);
    await repositories.transactions.save(transaction);

    await this.enqueue(
      repositories,
      WagerTransactionProcessed.from(
        transaction,
        this.eventContext(correlationId, now, transaction.id),
      ),
    );
    await this.enqueue(
      repositories,
      WalletBalanceChanged.from(
        wallet,
        entry,
        this.eventContext(correlationId, now, transaction.id),
      ),
    );

    return this.recorded(transaction, wallet.balance);
  }

  private async schedulePendingReference(
    repositories: Repositories,
    transaction: WagerTransaction,
    wallet: Wallet,
    now: Date,
    correlationId: string,
  ): Promise<SubmitWagerTransactionResult> {
    /*
      A submissão já consultou a referência e não a achou: é a tentativa 1, e
      esta chamada agenda a segunda.
    */
    transaction.markPendingReference(
      new Date(now.getTime() + referenceRetryDelayMs(1)),
    );
    await repositories.transactions.save(transaction);

    await this.enqueue(
      repositories,
      WagerTransactionPendingReference.from(
        transaction,
        this.eventContext(correlationId, now, transaction.id),
      ),
    );

    return this.recorded(transaction, wallet.balance);
  }

  // Recusa de transação que já está no banco.
  private async rejectInserted(
    repositories: Repositories,
    transaction: WagerTransaction,
    failureCode: FailureCode,
    now: Date,
    wallet: Wallet,
    correlationId: string,
  ): Promise<SubmitWagerTransactionResult> {
    /*
      Regra 6: recusa não altera saldo nem gera ledger. A wallet não é salva
      porque nada nela mudou e o agregado foi desenhado para ficar intacto
      quando o movimento é negado.
    */
    transaction.reject(failureCode, now, wallet.balance);
    await repositories.transactions.save(transaction);
    await this.enqueueRejected(repositories, transaction, now, correlationId);

    return this.recorded(transaction, wallet.balance);
  }

  /*
    Recusa de transação que a unicidade impediu de entrar.

    Acontece só na reversão duplicada: o índice parcial recusa os estados
    vivos e aceita `REJECTED`, então marcar e inserir deixa a tentativa
    auditável.
  */
  private async rejectUninserted(
    repositories: Repositories,
    transaction: WagerTransaction,
    failureCode: FailureCode,
    now: Date,
    wallet: Wallet,
    correlationId: string,
  ): Promise<SubmitWagerTransactionResult> {
    transaction.reject(failureCode, now, wallet.balance);

    if (!(await repositories.transactions.tryInsert(transaction)).inserted) {
      throw new InvariantViolationError(
        `não foi possível registrar a recusa da transação ` +
          `${transaction.externalTransactionId}: a unicidade recusou também ` +
          'a linha REJECTED',
      );
    }

    await this.enqueueRejected(repositories, transaction, now, correlationId);

    return this.recorded(transaction, wallet.balance);
  }

  private async enqueueRejected(
    repositories: Repositories,
    transaction: WagerTransaction,
    now: Date,
    correlationId: string,
  ): Promise<void> {
    await this.enqueue(
      repositories,
      WagerTransactionRejected.from(
        transaction,
        this.eventContext(correlationId, now, transaction.id),
      ),
    );
  }

  private async enqueue(
    repositories: Repositories,
    event: IntegrationEvent<unknown>,
  ): Promise<void> {
    await repositories.outbox.enqueue(OutboxMessage.enqueue(event));
  }

  private recorded(
    transaction: WagerTransaction,
    balance: Money,
  ): SubmitWagerTransactionResult {
    return {
      outcome: 'recorded',
      transaction,
      balance,
      idempotentReplay: false,
    };
  }

  // Um `eventId` por evento; correlação e causação compartilhadas.
  private eventContext(
    correlationId: string,
    occurredAt: Date,
    causationId: string,
  ): EventContext {
    return {
      eventId: this.ids.next(),
      correlationId,
      causationId,
      occurredAt,
    };
  }
}
