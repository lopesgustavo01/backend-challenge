import { describe, expect, test } from "bun:test";
import { BadRequestException, HttpException } from "@nestjs/common";
import { mapError } from "@/http/app-exception.filter";
import {
  IdempotencyConflictError,
  InvalidCommandError,
  TransactionNotFoundError,
  TransientProcessingError,
  WalletAlreadyExistsError,
  WalletMismatchError,
  WalletNotFoundError,
} from "@/modules/wagering/application/errors";

describe("mapError", () => {
  test.each([
    ["InvalidCommand", new InvalidCommandError("x"), 400, "INVALID_PAYLOAD"],
    ["WalletNotFound", new WalletNotFoundError("x"), 404, "WALLET_NOT_FOUND"],
    ["TransactionNotFound", new TransactionNotFoundError("x"), 404, "TRANSACTION_NOT_FOUND"],
    ["IdempotencyConflict", new IdempotencyConflictError("x"), 409, "IDEMPOTENCY_CONFLICT"],
    ["WalletAlreadyExists", new WalletAlreadyExistsError("x"), 409, undefined],
    ["Transient", new TransientProcessingError("x"), 503, "TRANSIENT_FAILURE"],
    ["HttpException 404", new HttpException("nope", 404), 404, "NOT_FOUND"],
    ["BadRequestException", new BadRequestException("bad"), 400, "INVALID_PAYLOAD"],
    ["parser JSON", Object.assign(new Error("Unexpected token"), { status: 400, type: "entity.parse.failed" }), 400, "INVALID_PAYLOAD"],
    ["parser grande", Object.assign(new Error("too large"), { status: 413 }), 413, "PAYLOAD_TOO_LARGE"],
  ])("%s", (_n, err, status, code) => {
    const m = mapError(err);
    expect(m.status).toBe(status);
    if (code) expect(m.code).toBe(code);
  });

  test("mismatch vira 422 com o código do erro", () => {
    const m = mapError(new WalletMismatchError("PLAYER_MISMATCH", "x"));
    expect(m.status).toBe(422);
    expect(m.code).toBe("PLAYER_MISMATCH");
  });

  test("503 pede retry", () => expect(mapError(new TransientProcessingError("x")).retryAfterSeconds).toBe(1));

  test("erro desconhecido: 500 genérico, sem vazar a mensagem", () => {
    const m = mapError(new Error("connection string postgres://user:secret@host"));
    expect(m).toEqual({ status: 500, code: "INTERNAL_ERROR", message: "Internal server error" });
  });

  test("parser com mensagem interna não vaza", () => {
    const m = mapError(Object.assign(new Error("secret detail"), { status: 400, type: "other" }));
    expect(m.message).not.toContain("secret");
  });
});
