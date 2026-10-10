import { Inject, Injectable, NestMiddleware } from "@nestjs/common";
import type { AppLogger, Metrics } from "@/shared/application/ports";
import { LOGGER, METRICS } from "@/shared/application/tokens";
import type { HttpRequest, HttpResponse } from "./http-types";

/** Padrão registrado em HttpApiModule.configure(); se for o que sobrou em req.route, nenhuma rota real casou. */
export const CATCH_ALL_PATTERN = "{*path}";

type Res = HttpResponse & { statusCode?: number; once(event: string, cb: () => void): void };

/**
 * Uma linha de log JSON por requisição (com correlationId) e contadores por rota/status. É middleware (e não
 * interceptor) para também enxergar rotas inexistentes e erros. O label `route` é o PADRÃO da rota
 * (/wallets/:walletId), nunca a URL concreta: cardinalidade limitada. Corpo, headers e query nunca são logados.
 */
@Injectable()
export class RequestLogMiddleware implements NestMiddleware {
  constructor(
    @Inject(LOGGER) private readonly logger: AppLogger,
    @Inject(METRICS) private readonly metrics: Metrics,
  ) {}

  use(req: HttpRequest, res: Res, next: () => void): void {
    const started = performance.now();
    res.once("finish", () => {
      const status = res.statusCode ?? 0;
      const matched = req.route?.path;
      const route = matched === undefined || matched === `/${CATCH_ALL_PATTERN}` ? "unmatched" : matched;
      const durationMs = Math.round((performance.now() - started) * 100) / 100;
      this.metrics.increment("http_requests_total", { method: req.method ?? "?", route, status: String(status) });
      this.metrics.increment("http_request_duration_ms_sum", { route }, durationMs);
      this.logger.info("http request", { correlationId: req.correlationId, method: req.method, route, status, durationMs });
    });
    next();
  }
}
