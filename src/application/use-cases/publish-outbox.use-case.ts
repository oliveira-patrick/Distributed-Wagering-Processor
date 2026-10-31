import type { IntegrationEventPublisher } from '../ports/event-publisher.port';
import type { LoggerPort } from '../ports/logger.port';
import { Metric } from '../ports/metrics.port';
import type { MetricsPort } from '../ports/metrics.port';
import type { Clock } from '../ports/system.port';
import type { UnitOfWork } from '../ports/unit-of-work';
import { describeError } from '../../shared/describe-error';
import { isTransportFailure } from '../../shared/transport-failure';

export interface PublishOutboxResult {
  readonly claimed: number;
  readonly published: number;
  readonly retried: number;
  /*
    Os eventos que **esta** passada publicou.

    Existe para que a disjunção entre publicadores concorrentes seja
    verificável: com duas passadas simultâneas, a interseção dos dois
    conjuntos precisa ser vazia, e é isso que o `for update skip locked`
    garante. Sem os ids, o teste só conseguiria afirmar contagens, que
    passariam igual se os dois tivessem publicado o mesmo evento.
  */
  readonly publishedIds: readonly string[];
}

/*
  Publicador da outbox.

  **Reivindica, publica, marca e comita, tudo na mesma transação.** A ordem é
  a decisão central, e tem um custo que vale enunciar: entre o `SendMessage`
  bem-sucedido e o `commit` existe uma janela em que o processo pode morrer.
  Se morrer ali, a linha continua pendente e outra instância publica o evento
  **de novo**.

  Isso é aceito de propósito, porque a alternativa é pior. Marcar como
  publicado antes de publicar fecharia a janela de duplicação e abriria a de
  **perda**. Perder um evento confirmado viola uma invariante global do
  sistema; publicação duplicada é segura para um consumidor idempotente. Daí
  o `MessageDeduplicationId` ser o `eventId`: dentro da janela do broker a
  duplicata nem chega, e fora dela o consumidor a recusa pelo inbox.

  Vários publicadores concorrentes não se atrapalham: o `claimDue` usa
  `for update skip locked`, então cada um leva um lote disjunto e quem chega
  depois pula as linhas tomadas em vez de enfileirar atrás delas. Ver
  ADR-012.
*/
export class PublishOutboxUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly publisher: IntegrationEventPublisher,
    private readonly clock: Clock,
    private readonly logger: LoggerPort,
    private readonly metrics: MetricsPort,
    private readonly batchSize: number,
  ) {}

  async publishDue(): Promise<PublishOutboxResult> {
    return this.unitOfWork.run(async (repositories) => {
      const due = await repositories.outbox.claimDue(
        this.clock.now(),
        this.batchSize,
      );

      const publishedIds: string[] = [];
      let retried = 0;

      for (const message of due) {
        try {
          await this.publisher.publish(message);
          message.markPublished(this.clock.now());
          publishedIds.push(message.id);
          this.metrics.increment(Metric.OutboxPublishedTotal, {
            outcome: 'published',
          });
        } catch (error) {
          /*
            A falha de um evento não derruba o lote.

            Deixar a exceção subir reverteria a transação inteira e
            republicaria os eventos que já tinham ido — gasto inútil, e
            contagem de tentativas que nunca avança. Com o `catch` por
            evento, quem falhou recebe backoff e os outros seguem.
          */
          message.scheduleRetry(this.clock.now());
          retried += 1;

          this.metrics.increment(Metric.OutboxPublishedTotal, {
            outcome: 'retry',
          });
          this.metrics.increment(Metric.RetriesTotal, { subject: 'outbox' });

          this.logger.warn('falha ao publicar evento; reagendado', {
            eventId: message.id,
            eventType: message.eventType,
            walletId: message.aggregateId,
            attempts: message.attempts,
            transient: isTransportFailure(error),
            detail: describeError(error),
          });
        }

        await repositories.outbox.save(message);
      }

      return {
        claimed: due.length,
        published: publishedIds.length,
        retried,
        publishedIds,
      };
    });
  }

  /*
    Mede o outbox lag.

    Transação própria, separada da publicação, e isso importa: dentro da
    transação que acabou de reivindicar o lote, as linhas reivindicadas
    ainda contam como pendentes, e o lag sairia inflado em exatamente o
    tamanho do lote.
  */
  async reportLag(): Promise<void> {
    const stats = await this.unitOfWork.run((repositories) =>
      repositories.outbox.pendingStats(),
    );

    this.metrics.gauge(Metric.OutboxPendingCount, stats.pending);
    this.metrics.gauge(
      Metric.OutboxPendingAgeSeconds,
      stats.oldestOccurredAt === undefined
        ? 0
        : Math.max(
            0,
            (this.clock.now().getTime() - stats.oldestOccurredAt.getTime()) /
              1_000,
          ),
    );
  }
}
