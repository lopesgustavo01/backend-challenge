import { createHash } from "node:crypto";
import { Money, MoneyProps } from "@/shared/domain/money";

/**
 * payloadHash = SHA-256 (hex minúsculo) do JSON canônico UTF-8 dos CAMPOS DE NEGÓCIO.
 *
 * JSON canônico: chaves ordenadas lexicograficamente em todos os níveis, sem espaços,
 * `undefined` vira `null`. Fora do hash: o header Idempotency-Key e metadados de transporte
 * (messageId, correlationId, occurredAt). O valor entra normalizado ("25" == "25.00").
 */
export interface PayloadHashFields {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

export function canonicalJson(value: unknown): string {
  if (value === undefined || value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
    );
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function computePayloadHash(fields: PayloadHashFields): string {
  const normalized = {
    providerId: fields.providerId,
    externalTransactionId: fields.externalTransactionId,
    playerId: fields.playerId,
    walletId: fields.walletId,
    roundId: fields.roundId,
    gameId: fields.gameId,
    kind: fields.kind,
    money: Money.from(fields.money).toJSON(),
    referenceExternalTransactionId:
      fields.referenceExternalTransactionId ?? null,
  };
  return createHash("sha256")
    .update(canonicalJson(normalized), "utf8")
    .digest("hex");
}
