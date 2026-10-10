import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Inject } from "@nestjs/common";
import type { AppLogger } from "@/shared/application/ports";
import { LOGGER } from "@/shared/application/tokens";
import {
  IdempotencyConflictError,
  InvalidCommandError,
  TransactionNotFoundError,
  TransientProcessingError,
  WalletAlreadyExistsError,
  WalletMismatchError,
  WalletNotFoundError,
} from "@/modules/wagering/application/errors";
import { CORRELATION_HEADER } from "./correlation";
import type { HttpRequest, HttpResponse } from "./http-types";

export interface MappedError {
  status: number;
  code: string;
  message: string;
  retryAfterSeconds?: number;
}

const GENERIC_CODES: Record<number, string> = {
  400: "INVALID_PAYLOAD",
  401: "UNAUTHORIZED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  405: "METHOD_NOT_ALLOWED",
  413: "PAYLOAD_TOO_LARGE",
  415: "UNSUPPORTED_MEDIA_TYPE",
  429: "TOO_MANY_REQUESTS",
};

/**
 * Mapa ÚNICO de erro -> HTTP, igual para todos os endpoints. O provedor decide o que fazer só pelo status:
 *   400  payload inválido            corrigir e reenviar
 *   404  wallet/transação inexistente
 *   409  conflito de idempotência    NÃO reenviar (a key já foi usada com outro conteúdo)
 *   422  player/moeda não batem com a wallet (nada foi gravado)
 *   503  falha transitória           reenviar a MESMA requisição é seguro (Retry-After)
 *   500  bug / erro inesperado       mensagem genérica, detalhes só no log
 * Rejeições de negócio PERSISTIDAS (REJECTED) não passam por aqui: voltam como corpo de resultado, ver views.ts.
 */
export function mapError(exception: unknown): MappedError {
  if (exception instanceof InvalidCommandError) return known(400, exception);
  if (exception instanceof WalletNotFoundError || exception instanceof TransactionNotFoundError) {
    return known(404, exception);
  }
  if (exception instanceof IdempotencyConflictError || exception instanceof WalletAlreadyExistsError) {
    return known(409, exception);
  }
  if (exception instanceof WalletMismatchError) return known(422, exception);
  if (exception instanceof TransientProcessingError) {
    return { ...known(503, exception), retryAfterSeconds: 1 };
  }

  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    return { status, code: GENERIC_CODES[status] ?? `HTTP_${status}`, message: exception.message };
  }

  // erros do parser de corpo (http-errors): JSON malformado, corpo grande demais...
  const parser = exception as { status?: unknown; statusCode?: unknown; type?: unknown } | null;
  const parserStatus = typeof parser?.status === "number" ? parser.status : parser?.statusCode;
  if (typeof parserStatus === "number" && parserStatus >= 400 && parserStatus < 500) {
    const message = parser?.type === "entity.parse.failed" ? "Request body is not valid JSON" : "Request could not be processed";
    return { status: parserStatus, code: GENERIC_CODES[parserStatus] ?? `HTTP_${parserStatus}`, message };
  }

  return { status: 500, code: "INTERNAL_ERROR", message: "Internal server error" };
}

function known(status: number, error: { code: string; message: string }): MappedError {
  return { status, code: error.code, message: error.message };
}

@Catch()
export class AppExceptionFilter implements ExceptionFilter {
  constructor(@Inject(LOGGER) private readonly logger: AppLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<HttpRequest>();
    const res = http.getResponse<HttpResponse>();
    const correlationId = req.correlationId;
    if (correlationId) res.setHeader(CORRELATION_HEADER, correlationId);

    // exceções com corpo próprio (ex.: o 503 do /health/ready com {status, postgres, sqs}) são preservadas
    if (exception instanceof HttpException) {
      const body = exception.getResponse();
      if (typeof body === "object" && body !== null && !("statusCode" in body)) {
        res.status(exception.getStatus());
        res.json(body);
        return;
      }
    }

    const mapped = mapError(exception);

    if (mapped.status >= 500) {
      // detalhes só no log (com correlationId), nunca na resposta; sem payload da requisição
      const level = mapped.status === 503 ? "warn" : "error";
      this.logger[level]("request failed", {
        correlationId,
        method: req.method,
        path: req.url?.split("?")[0],
        status: mapped.status,
        code: mapped.code,
        error: exception instanceof Error ? exception.message : String(exception),
      });
    }

    if (mapped.retryAfterSeconds !== undefined) res.setHeader("Retry-After", String(mapped.retryAfterSeconds));
    res.status(mapped.status);
    res.json({ error: { code: mapped.code, message: mapped.message } });
  }
}
