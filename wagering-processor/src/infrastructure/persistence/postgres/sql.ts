import { SqlEntityManager } from "@mikro-orm/postgresql";
import {
  ConnectionException,
  DeadlockException,
  LockWaitTimeoutException,
} from "@mikro-orm/core";

/**
 * Executor SQL ligado à transação corrente. O MikroORM usa `?` como placeholder (NÃO `$1`).
 * Nenhum SQL deste projeto usa o operador jsonb `?`.
 */
export type Executor = SqlEntityManager;

export async function query<T>(
  em: Executor,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  return (await em.execute(sql, params)) as unknown as T[];
}

/**
 * O driver devolve timestamptz como string em formato dependente do servidor; normalizamos para ISO-8601 UTC
 * no próprio SQL (ms de precisão, igual ao Date do JS) e fazemos `new Date()` no mapeamento.
 */
export const iso = (column: string, alias: string = column): string =>
  `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as ${alias}`;

export const toIso = (date: Date): string => date.toISOString();

const TRANSIENT_SQLSTATES = new Set([
  "40001", // serialization_failure
  "40P01", // deadlock_detected
  "55P03", // lock_not_available (lock_timeout)
  "57014", // query_canceled (statement_timeout)
  "57P01", // admin_shutdown
  "57P02", // crash_shutdown
  "57P03", // cannot_connect_now
  "53300", // too_many_connections
  "53400", // configuration_limit_exceeded
]);
const TRANSIENT_NODE_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "ENOTFOUND",
  "EAI_AGAIN",
]);

function codeOf(error: unknown): string | undefined {
  const e = error as { code?: unknown; cause?: { code?: unknown } } | null;
  const code = e?.code ?? e?.cause?.code;
  return typeof code === "string" ? code : undefined;
}

/** Falha de infraestrutura que desaparece sozinha: reenviar a mesma requisição é seguro (idempotente). */
export function isTransientDatabaseError(error: unknown): boolean {
  if (
    error instanceof DeadlockException ||
    error instanceof LockWaitTimeoutException ||
    error instanceof ConnectionException
  ) {
    return true;
  }
  const code = codeOf(error);
  return (
    code !== undefined &&
    (TRANSIENT_SQLSTATES.has(code) ||
      code.startsWith("08") ||
      TRANSIENT_NODE_CODES.has(code))
  );
}
