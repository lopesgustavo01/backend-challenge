import {
  BeforeApplicationShutdown,
  Inject,
  Injectable,
  OnApplicationBootstrap,
} from "@nestjs/common";
import type { AppLogger } from "@/shared/application/ports";
import { LOGGER } from "@/shared/application/tokens";
import { OutboxRelay } from "@/modules/wagering/application/outbox-relay";
import { PollingLoop } from "@/infrastructure/workers/polling-loop";

export const OUTBOX_LOOP_OPTIONS = Symbol("OUTBOX_LOOP_OPTIONS");
export interface OutboxLoopOptions {
  pollIntervalMs: number;
  /** false = não inicia o laço (ex.: processo que só atende HTTP). */
  enabled: boolean;
}

/**
 * Laço de longa duração do publicador. No desligamento (SIGTERM -> app.close()) para de reivindicar lotes novos e
 * ESPERA o lote em andamento terminar antes de o ORM ser fechado: nada fica meio processado.
 */
@Injectable()
export class OutboxPublisherService
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly loop: PollingLoop;

  constructor(
    @Inject(OutboxRelay) relay: OutboxRelay,
    @Inject(LOGGER) private readonly logger: AppLogger,
    @Inject(OUTBOX_LOOP_OPTIONS) private readonly options: OutboxLoopOptions,
  ) {
    // lote cheio = provavelmente há mais: não dorme
    this.loop = new PollingLoop(
      "outbox relay",
      async () => (await relay.runOnce()).claimed >= relay.batchSize,
      options.pollIntervalMs,
      logger,
    );
  }

  onApplicationBootstrap(): void {
    if (!this.options.enabled) {
      this.logger.info("outbox publisher disabled");
      return;
    }
    this.loop.start();
    this.logger.info("outbox publisher started", {
      pollIntervalMs: this.options.pollIntervalMs,
    });
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.stop();
  }

  stop(): Promise<void> {
    return this.loop.stop();
  }
}
