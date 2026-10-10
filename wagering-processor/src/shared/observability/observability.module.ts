import { Global, Module } from "@nestjs/common";
import { LOGGER, METRICS } from "@/shared/application/tokens";
import { InMemoryMetrics } from "./in-memory-metrics";
import { JsonLogger } from "./json-logger";

/** Global: qualquer módulo recebe LOGGER e METRICS por token. Testes substituem por versões que capturam. */
@Global()
@Module({
  providers: [
    { provide: LOGGER, useClass: JsonLogger },
    { provide: METRICS, useClass: InMemoryMetrics },
  ],
  exports: [LOGGER, METRICS],
})
export class ObservabilityModule {}
