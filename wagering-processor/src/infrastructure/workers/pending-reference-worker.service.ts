import {
  BeforeApplicationShutdown,
  Inject,
  Injectable,
  OnApplicationBootstrap,
} from "@nestjs/common";
import type { AppLogger } from "@/shared/application/ports";
import { LOGGER } from "@/shared/application/tokens";
import { ReprocessPendingReferencesUseCase } from "@/modules/wagering/application/reprocess-pending-references.use-case";
import { PollingLoop } from "./polling-loop";

export const PENDING_REFERENCE_WORKER_OPTIONS = Symbol(
  "PENDING_REFERENCE_WORKER_OPTIONS",
);
export interface PendingReferenceWorkerOptions {
  enabled: boolean;
  pollIntervalMs: number;
  batchSize: number;
}

@Injectable()
export class PendingReferenceWorker
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly loop: PollingLoop;

  constructor(
    @Inject(ReprocessPendingReferencesUseCase)
    useCase: ReprocessPendingReferencesUseCase,
    @Inject(LOGGER) private readonly logger: AppLogger,
    @Inject(PENDING_REFERENCE_WORKER_OPTIONS)
    private readonly options: PendingReferenceWorkerOptions,
  ) {
    this.loop = new PollingLoop(
      "pending-reference worker",
      async () =>
        (await useCase.runOnce(options.batchSize)).due >= options.batchSize,
      options.pollIntervalMs,
      logger,
    );
  }

  onApplicationBootstrap(): void {
    if (!this.options.enabled) {
      this.logger.info("pending-reference worker disabled");
      return;
    }
    this.loop.start();
    this.logger.info("pending-reference worker started", {
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
