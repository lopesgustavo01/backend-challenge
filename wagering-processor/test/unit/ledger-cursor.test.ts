import { describe, expect, test } from "bun:test";
import { InvalidCommandError } from "@/modules/wagering/application/errors";
import { decodeLedgerCursor, encodeLedgerCursor } from "@/modules/wallet/application/ledger-cursor";

const W = "0192f0e0-0000-7000-8000-000000000001";
const raw = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

describe("ledger cursor", () => {
  test("round-trip", () => expect(decodeLedgerCursor(encodeLedgerCursor(W, "42"), W)).toBe("42"));
  test("é opaco (base64url, sem JSON legível)", () => expect(encodeLedgerCursor(W, "42")).toMatch(/^[A-Za-z0-9_-]+$/));
  test("de outra wallet é inválido", () => {
    expect(() => decodeLedgerCursor(encodeLedgerCursor(W, "1"), "outra")).toThrow(InvalidCommandError);
  });
  test.each([
    ["vazio", ""],
    ["lixo", "%%%"],
    ["não-JSON", Buffer.from("abc").toString("base64url")],
    ["versão errada", raw({ v: 2, w: W, s: "1" })],
    ["seq numérica (não string)", raw({ v: 1, w: W, s: 1 })],
    ["seq negativa", raw({ v: 1, w: W, s: "-1" })],
    ["seq com injeção", raw({ v: 1, w: W, s: "1; drop table wallets" })],
    ["null", raw(null)],
    ["grande demais", "A".repeat(300)],
  ])("rejeita %s", (_n, c) => expect(() => decodeLedgerCursor(c, W)).toThrow(InvalidCommandError));
});
