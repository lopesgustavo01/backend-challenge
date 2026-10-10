import { CallHandler, ExecutionContext, Injectable, NestInterceptor, createParamDecorator } from "@nestjs/common";
import { Observable } from "rxjs";
import type { HttpRequest, HttpResponse } from "./http-types";

export const CORRELATION_HEADER = "x-correlation-id";

/** Aceita só ids "seguros" (vão para logs e cabeçalhos); qualquer outra coisa é substituída por um id novo. */
const SAFE_ID = /^[A-Za-z0-9_.:\-]{1,128}$/;

/** Define o correlationId da requisição (o do cliente, se válido) e o devolve no cabeçalho de resposta. */
@Injectable()
export class CorrelationInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<HttpRequest>();
    const res = http.getResponse<HttpResponse>();

    const incoming = req.headers[CORRELATION_HEADER];
    const correlationId = typeof incoming === "string" && SAFE_ID.test(incoming) ? incoming : crypto.randomUUID();
    req.correlationId = correlationId;
    res.setHeader(CORRELATION_HEADER, correlationId);
    return next.handle();
  }
}

export const CorrelationId = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string | undefined =>
    context.switchToHttp().getRequest<HttpRequest>().correlationId,
);
