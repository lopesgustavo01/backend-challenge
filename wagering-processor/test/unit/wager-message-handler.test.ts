import { describe, expect, test } from "bun:test";
import {
  IdempotencyConflictError,
  InvalidCommandError,
  TransientProcessingError,
  WalletMismatchError,
  WalletNotFoundError,
} from "@/modules/wagering/application/errors";
import { WagerTransactionStatus } from "@/modules/wagering/domain/wager-transaction";
import { WAGER_CONSUMER_NAME, WagerMessageHandler } from "@/infrastructure/messaging/wager-message-handler";
import { InMemoryMetrics } from "@/shared/observability/in-memory-metrics";
import { CapturingLogger } from "../integration/helpers/http-server";

const valid = {
  providerId: "p", externalTransactionId: "e1", playerId: "pl", walletId: "w", roundId: "r", gameId: "g",
  kind: "BET", money: { amount: "10.00", currency: "BRL" },
};

function build(execute: (cmd: any) => Promise<any>) {
  const calls: any[] = [];
  const handler = new WagerMessageHandler({ execute: async (c) => { calls.push(c); return execute(c); } }, new CapturingLogger(), new InMemoryMetrics());
  return { handler, calls };
}
const ok = (replay = false, status = WagerTransactionStatus.Processed) => async () => ({ transactionId: "t", status, idempotentReplay: replay });

describe("WagerMessageHandler: decisão por tipo de resultado/erro", () => {
  test("processada -> ack, com messageId no inbox, key default e correlationId", async () => {
    const { handler, calls } = build(ok());
    const d = await handler.handle({ messageId: "m1", body: JSON.stringify(valid), correlationId: "c1" });
    expect(d).toEqual({ kind: "ack", outcome: "processed" });
    expect(calls[0]).toMatchObject({
      idempotencyKey: "p:e1",
      correlationId: "c1",
      inbox: { consumerName: WAGER_CONSUMER_NAME, messageId: "m1" },
    });
  });

  test("idempotencyKey do corpo tem precedência; sem correlationId usa o messageId", async () => {
    const { handler, calls } = build(ok());
    await handler.handle({ messageId: "m1", body: JSON.stringify({ ...valid, idempotencyKey: "minha-key" }) });
    expect(calls[0].idempotencyKey).toBe("minha-key");
    expect(calls[0].correlationId).toBe("m1");
  });

  test("replay -> ack 'duplicate'; rejeição de negócio e pendente -> ack", async () => {
    expect(await build(ok(true)).handler.handle({ messageId: "m", body: JSON.stringify(valid) })).toEqual({ kind: "ack", outcome: "duplicate" });
    expect(await build(ok(false, WagerTransactionStatus.Rejected)).handler.handle({ messageId: "m", body: JSON.stringify(valid) })).toEqual({ kind: "ack", outcome: "rejected" });
    expect(await build(ok(false, WagerTransactionStatus.PendingReference)).handler.handle({ messageId: "m", body: JSON.stringify(valid) })).toEqual({ kind: "ack", outcome: "pending_reference" });
  });

  test.each([
    ["JSON inválido", "{nope"],
    ["não é objeto", "[1,2]"],
    ["campo faltando", JSON.stringify({ ...valid, walletId: undefined })],
    ["amount numérico", JSON.stringify({ ...valid, money: { amount: 10, currency: "BRL" } })],
    ["idempotencyKey vazia", JSON.stringify({ ...valid, idempotencyKey: "" })],
  ])("corpo inválido (%s) -> dead-letter sem chamar o use case", async (_n, body) => {
    const { handler, calls } = build(ok());
    const d = await handler.handle({ messageId: "m", body });
    expect(d.kind).toBe("dead-letter");
    expect(calls).toHaveLength(0);
  });

  test.each([
    ["InvalidCommand", new InvalidCommandError("x"), "dead-letter"],
    ["IdempotencyConflict", new IdempotencyConflictError("x"), "dead-letter"],
    ["PlayerMismatch", new WalletMismatchError("PLAYER_MISMATCH", "x"), "dead-letter"],
    ["WalletNotFound", new WalletNotFoundError("x"), "retry"],
    ["Transient", new TransientProcessingError("x"), "retry"],
    ["desconhecido", new Error("boom"), "retry"],
  ])("%s -> %s", async (_n, error, kind) => {
    const { handler } = build(async () => { throw error; });
    expect((await handler.handle({ messageId: "m", body: JSON.stringify(valid) })).kind).toBe(kind as "retry" | "dead-letter");
  });
});
