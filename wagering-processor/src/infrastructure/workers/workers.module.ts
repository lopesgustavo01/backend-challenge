import { Module } from "@nestjs/common";
import { loadEnv } from "@/config/env";
import { ApplicationModule } from "@/application.module";
import {
  PENDING_REFERENCE_WORKER_OPTIONS,
  PendingReferenceWorker,
} from "./pending-reference-worker.service";

/** Workers de fundo (rodam em toda instância; a coordenação é feita pelos locks do banco). */
@Module({
  imports: [ApplicationModule],
  providers: [
    {
      provide: PENDING_REFERENCE_WORKER_OPTIONS,
      useFactory: () => {
        const env = loadEnv();
        return {
          enabled: env.PENDING_REFERENCE_WORKER_ENABLED,
          pollIntervalMs: env.PENDING_REFERENCE_POLL_INTERVAL_MS,
          batchSize: env.PENDING_REFERENCE_BATCH_SIZE,
        };
      },
    },
    PendingReferenceWorker,
  ],
})
export class WorkersModule {}
