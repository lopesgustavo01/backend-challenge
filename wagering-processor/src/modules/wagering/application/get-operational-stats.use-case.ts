import type { Clock } from "@/shared/application/ports";
import { OutboxStats, PendingReferenceStats, UnitOfWork } from "./ports";

export interface OperationalStats {
  outbox: OutboxStats;
  pendingReference: PendingReferenceStats;
}

/** Backlogs que os contadores do processo não enxergam: vivem no banco e valem para todas as instâncias. */
export class GetOperationalStatsUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
  ) {}

  async execute(): Promise<OperationalStats> {
    const now = this.clock.now();
    return this.uow.run(async (repos) => ({
      outbox: await repos.outbox.stats(now),
      pendingReference: await repos.transactions.pendingReferenceStats(now),
    }));
  }
}
