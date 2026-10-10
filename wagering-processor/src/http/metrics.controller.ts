import { Controller, Get, Header, Inject } from "@nestjs/common";
import { GetOperationalStatsUseCase } from "@/modules/wagering/application/get-operational-stats.use-case";
import { InMemoryMetrics } from "@/shared/observability/in-memory-metrics";
import { renderPrometheus } from "@/shared/observability/prometheus";
import { METRICS } from "@/shared/application/tokens";

/**
 * GET /metrics (Prometheus). Contadores são do PROCESSO (cada instância é raspada separadamente);
 * os gauges de backlog vêm do banco e são os mesmos em qualquer instância.
 */
@Controller("metrics")
export class MetricsController {
  constructor(
    @Inject(METRICS) private readonly metrics: InMemoryMetrics,
    @Inject(GetOperationalStatsUseCase) private readonly stats: GetOperationalStatsUseCase,
  ) {}

  @Get()
  @Header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
  async scrape(): Promise<string> {
    const s = await this.stats.execute();
    return renderPrometheus(this.metrics.entries(), [
      { name: "outbox_pending_messages", help: "Outbox messages not yet published", value: s.outbox.pending },
      { name: "outbox_failing_messages", help: "Pending outbox messages that already failed at least once", value: s.outbox.failing },
      { name: "outbox_lag_seconds", help: "Age of the oldest unpublished outbox message", value: s.outbox.oldestPendingAgeSeconds },
      { name: "pending_reference_transactions", help: "Transactions waiting for their reference", value: s.pendingReference.count },
      { name: "pending_reference_oldest_age_seconds", help: "Age of the oldest transaction waiting for its reference", value: s.pendingReference.oldestAgeSeconds },
    ]);
  }
}
