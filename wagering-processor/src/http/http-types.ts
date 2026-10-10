/**
 * Contratos mínimos de request/response usados pela camada HTTP. Evita acoplar o código a @types/express:
 * o Nest entrega objetos do Express em runtime e aqui só declaramos o que usamos.
 */
export interface HttpRequest {
  headers: Record<string, string | string[] | undefined>;
  correlationId?: string;
  method?: string;
  url?: string;
  route?: { path?: string };
}

export interface HttpResponse {
  status(code: number): unknown;
  setHeader(name: string, value: string): unknown;
  json(body: unknown): unknown;
}
