import { z } from "zod";
import { InvalidCommandError } from "@/modules/wagering/application/errors";

import { createWalletSchema, submitTransactionSchema } from "@/modules/wagering/application/transaction-input";
export { createWalletSchema, submitTransactionSchema };

export function parseBody<T extends z.ZodType>(schema: T, body: unknown): z.output<T> {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "body"}: ${issue.message}`)
      .join("; ");
    throw new InvalidCommandError(detail);
  }
  return parsed.data;
}

/** Query string: ausente ou vazio = não informado; repetido (?x=1&x=2) ou fora do formato = inválido. */
export function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string") throw new InvalidCommandError(`${name} must be a single value`);
  return value;
}

export function optionalInteger(value: unknown, name: string): number | undefined {
  const text = optionalString(value, name);
  if (text === undefined) return undefined;
  if (!/^\d{1,9}$/.test(text)) throw new InvalidCommandError(`${name} must be a non-negative integer`);
  return Number(text);
}
