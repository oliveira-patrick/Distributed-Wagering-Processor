import { Module } from '@nestjs/common';

import { LOGGER } from '../../application/ports/logger.port';
import type { LoggerPort } from '../../application/ports/logger.port';
import { EVENT_PUBLISHER } from '../../application/ports/event-publisher.port';
import type { IntegrationEventPublisher } from '../../application/ports/event-publisher.port';
import { METRICS } from '../../application/ports/metrics.port';
import type { MetricsPort } from '../../application/ports/metrics.port';
import { PROVIDER_IDENTITY } from '../../application/ports/provider-identity.port';
import type { ProviderIdentityPort } from '../../application/ports/provider-identity.port';
import { CLOCK, ID_GENERATOR } from '../../application/ports/system.port';
import type { Clock, IdGenerator } from '../../application/ports/system.port';
import { UNIT_OF_WORK } from '../../application/ports/unit-of-work';
import type { UnitOfWork } from '../../application/ports/unit-of-work';
import { EnvService } from '../../config/env.service';
import { ConsumeWagerMessageUseCase } from '../../application/use-cases/consume-wager-message.use-case';
import { CreateWalletUseCase } from '../../application/use-cases/create-wallet.use-case';
import { PublishOutboxUseCase } from '../../application/use-cases/publish-outbox.use-case';
import { ReconcileWalletUseCase } from '../../application/use-cases/reconcile-wallet.use-case';
import { RetryPendingReferenceUseCase } from '../../application/use-cases/retry-pending-reference.use-case';
import { SubmitWagerTransactionUseCase } from '../../application/use-cases/submit-wager-transaction.use-case';
import { GetWagerTransactionUseCase } from '../../application/use-cases/wager-transaction-queries.use-case';
import {
  GetWalletLedgerUseCase,
  GetWalletUseCase,
} from '../../application/use-cases/wallet-queries.use-case';
import { MessagingModule } from '../messaging/messaging.module';
import { PersistenceModule } from '../persistence/persistence.module';
import { SystemModule } from '../system/system.module';

/*
  Composição dos casos de uso.

  Mora em `infrastructure` de propósito. Os casos de uso em si não têm nenhum
  import de framework — nem decorator, nem token, nem módulo —, e é essa
  propriedade que faz a camada de aplicação ser testável sem subir Nest. O
  preço de mantê-la é que alguém precisa instanciá-los à mão, e esse alguém é
  este arquivo: injeção explícita por `useFactory`, com os tokens das portas.

  A alternativa seria decorar os casos de uso com `@Injectable()` e `@Inject()`.
  Custa menos linhas aqui e amarra a aplicação ao framework em todo arquivo —
  troca que a regra de dependência do ADR-001 não aceita.

  Exporta usando a própria classe como token, de modo que quem injeta declara o
  tipo concreto e não um símbolo.
*/
@Module({
  /*
    `MessagingModule` entra pelo `EVENT_PUBLISHER`, de que o publicador da
    outbox depende. É a única dependência de infraestrutura de mensageria em
    toda a camada de aplicação, e ela chega por porta.
  */
  imports: [PersistenceModule, SystemModule, MessagingModule],
  providers: [
    {
      provide: CreateWalletUseCase,
      inject: [UNIT_OF_WORK, CLOCK, ID_GENERATOR],
      useFactory: (
        unitOfWork: UnitOfWork,
        clock: Clock,
        ids: IdGenerator,
      ): CreateWalletUseCase => new CreateWalletUseCase(unitOfWork, clock, ids),
    },
    {
      provide: SubmitWagerTransactionUseCase,
      inject: [UNIT_OF_WORK, PROVIDER_IDENTITY, CLOCK, ID_GENERATOR],
      useFactory: (
        unitOfWork: UnitOfWork,
        identity: ProviderIdentityPort,
        clock: Clock,
        ids: IdGenerator,
      ): SubmitWagerTransactionUseCase =>
        new SubmitWagerTransactionUseCase(unitOfWork, identity, clock, ids),
    },
    {
      /*
        O consumidor da fila: abre a transação, grava o inbox e delega ao
        `executeWithin` do caso de uso de submissão, de modo que inbox e
        efeito financeiro caiam no mesmo commit.
      */
      provide: ConsumeWagerMessageUseCase,
      inject: [
        UNIT_OF_WORK,
        SubmitWagerTransactionUseCase,
        CLOCK,
        ID_GENERATOR,
        LOGGER,
        METRICS,
        EnvService,
      ],
      useFactory: (
        unitOfWork: UnitOfWork,
        submit: SubmitWagerTransactionUseCase,
        clock: Clock,
        ids: IdGenerator,
        logger: LoggerPort,
        metrics: MetricsPort,
        env: EnvService,
      ): ConsumeWagerMessageUseCase =>
        new ConsumeWagerMessageUseCase(
          unitOfWork,
          submit,
          clock,
          ids,
          logger,
          metrics,
          env.sqs.consumerName,
        ),
    },
    {
      provide: PublishOutboxUseCase,
      inject: [
        UNIT_OF_WORK,
        EVENT_PUBLISHER,
        CLOCK,
        LOGGER,
        METRICS,
        EnvService,
      ],
      useFactory: (
        unitOfWork: UnitOfWork,
        publisher: IntegrationEventPublisher,
        clock: Clock,
        logger: LoggerPort,
        metrics: MetricsPort,
        env: EnvService,
      ): PublishOutboxUseCase =>
        new PublishOutboxUseCase(
          unitOfWork,
          publisher,
          clock,
          logger,
          metrics,
          env.workers.outboxBatchSize,
        ),
    },
    {
      /*
        Worker de referência: reusa o mesmo caso de uso de submissão para
        aplicar o efeito tardio, pelo mesmo caminho da API e da fila.
      */
      provide: RetryPendingReferenceUseCase,
      inject: [
        UNIT_OF_WORK,
        SubmitWagerTransactionUseCase,
        CLOCK,
        ID_GENERATOR,
        LOGGER,
        METRICS,
        EnvService,
      ],
      useFactory: (
        unitOfWork: UnitOfWork,
        submit: SubmitWagerTransactionUseCase,
        clock: Clock,
        ids: IdGenerator,
        logger: LoggerPort,
        metrics: MetricsPort,
        env: EnvService,
      ): RetryPendingReferenceUseCase =>
        new RetryPendingReferenceUseCase(
          unitOfWork,
          submit,
          clock,
          ids,
          logger,
          metrics,
          env.workers.referenceBatchSize,
        ),
    },
    {
      provide: GetWalletUseCase,
      inject: [UNIT_OF_WORK],
      useFactory: (unitOfWork: UnitOfWork): GetWalletUseCase =>
        new GetWalletUseCase(unitOfWork),
    },
    {
      provide: GetWalletLedgerUseCase,
      inject: [UNIT_OF_WORK],
      useFactory: (unitOfWork: UnitOfWork): GetWalletLedgerUseCase =>
        new GetWalletLedgerUseCase(unitOfWork),
    },
    {
      provide: GetWagerTransactionUseCase,
      inject: [UNIT_OF_WORK],
      useFactory: (unitOfWork: UnitOfWork): GetWagerTransactionUseCase =>
        new GetWagerTransactionUseCase(unitOfWork),
    },
    {
      provide: ReconcileWalletUseCase,
      inject: [UNIT_OF_WORK, LOGGER],
      useFactory: (
        unitOfWork: UnitOfWork,
        logger: LoggerPort,
      ): ReconcileWalletUseCase =>
        new ReconcileWalletUseCase(unitOfWork, logger),
    },
  ],
  exports: [
    CreateWalletUseCase,
    SubmitWagerTransactionUseCase,
    ConsumeWagerMessageUseCase,
    GetWalletUseCase,
    GetWalletLedgerUseCase,
    GetWagerTransactionUseCase,
    ReconcileWalletUseCase,
    PublishOutboxUseCase,
    RetryPendingReferenceUseCase,
  ],
})
export class UseCasesModule {}
