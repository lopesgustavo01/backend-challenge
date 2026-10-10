import {
  AppLogger,
  Clock,
  EventPublisher,
  Metrics,
} from "@/shared/application/ports";
import { OutboxMessage } from "@/shared/messaging/outbox-message";
import { UnitOfWork } from "./ports";

export interface OutboxRelayOptions {
  batchSize: number;
  /** Quanto tempo a instância que reivindicou uma mensagem é a "dona" dela. Deve exceder o tempo de um envio. */
  leaseMs: number;
}

export const DEFAULT_OUTBOX_RELAY_OPTIONS: OutboxRelayOptions = {
  batchSize: 50,
  leaseMs: 30_000,
};

export interface OutboxRunResult {
  claimed: number;
  published: number;
  failed: number;
}

/**
 * Transmite o outbox para o broker. Roda em N instâncias ao mesmo tempo sem coordenação externa.
 *
 *  1. TX curta: reivindica (FOR UPDATE SKIP LOCKED) e aluga as mensagens vencidas; commit.
 *     Só linhas JÁ CONFIRMADAS são visíveis: nada é publicado antes do commit do efeito financeiro.
 *  2. Fora de transação: publica no broker (rede nunca segura conexão/locks do banco).
 *  3. TX curta por mensagem: marca publicada, ou agenda retry com backoff exponencial e guarda o erro.
 *
 * Falhas e o que acontece:
 *  - broker recusa/timeout        -> retry com backoff (attempts+1, last_error)
 *  - processo morre após o claim  -> o aluguel expira e outra instância assume
 *  - morre após enviar, antes de marcar -> será reenviada (at-least-once). Segura: o MessageDeduplicationId é o
 *    eventId (o SQS FIFO deduplica por 5 min) e o consumidor deduplica pelo inbox (eventId) sem limite de tempo.
 * A ordem entre eventos do mesmo agregado é "melhor esforço" (um retry pode ultrapassar outro evento); os eventos
 * carregam occurredAt e o consumidor não depende de ordem para ser correto.
 */
export class OutboxRelay {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly publisher: EventPublisher,
    private readonly clock: Clock,
    private readonly logger: AppLogger,
    private readonly metrics: Metrics,
    private readonly options: OutboxRelayOptions = DEFAULT_OUTBOX_RELAY_OPTIONS,
  ) {
    if (!Number.isInteger(options.batchSize) || options.batchSize < 1)
      throw new Error("batchSize must be >= 1");
    if (!Number.isInteger(options.leaseMs) || options.leaseMs < 1)
      throw new Error("leaseMs must be >= 1");
  }

  get batchSize(): number {
    return this.options.batchSize;
  }

  async runOnce(): Promise<OutboxRunResult> {
    const claimed = await this.uow.run((repos) =>
      repos.outbox.claimDue(
        this.clock.now(),
        this.options.batchSize,
        this.options.leaseMs,
      ),
    );

    let published = 0;
    let failed = 0;
    for (const message of claimed) {
      if (await this.deliver(message)) published++;
      else failed++;
    }
    return { claimed: claimed.length, published, failed };
  }

  private async deliver(message: OutboxMessage): Promise<boolean> {
    try {
      await this.publisher.publish(message);
    } catch (error) {
      await this.recordFailure(message, error);
      return false;
    }

    try {
      const marked = await this.uow.run((repos) =>
        repos.outbox.markPublished(message.id, this.clock.now()),
      );
      this.metrics.increment("outbox_published_total", {
        eventType: message.eventType,
      });
      if (!marked)
        this.logger.warn("outbox message was already marked published", {
          eventId: message.id,
        });
    } catch (error) {
      // Já está no broker; só não conseguimos registrar. O aluguel expira e a mensagem é reenviada (dedupe a absorve).
      this.logger.warn(
        "outbox message sent but not marked as published; it will be re-sent",
        {
          eventId: message.id,
          eventType: message.eventType,
          error: describe(error),
        },
      );
      this.metrics.increment("outbox_mark_failures_total");
    }
    return true;
  }

  private async recordFailure(
    message: OutboxMessage,
    error: unknown,
  ): Promise<void> {
    const text = describe(error);
    this.metrics.increment("outbox_publish_failures_total", {
      eventType: message.eventType,
    });
    try {
      message.scheduleRetry(this.clock.now());
      await this.uow.run((repos) => repos.outbox.saveRetry(message, text));
      this.logger.warn("outbox publish failed; retry scheduled", {
        eventId: message.id,
        eventType: message.eventType,
        attempts: message.attempts,
        nextAttemptAt: message.nextAttemptAt?.toISOString(),
        error: text,
      });
    } catch (saveError) {
      // Sem registrar a falha, vale o aluguel: a mensagem volta a ficar elegível quando ele expirar.
      this.logger.error("could not record outbox publish failure", {
        eventId: message.id,
        error: text,
        saveError: describe(saveError),
      });
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
}
