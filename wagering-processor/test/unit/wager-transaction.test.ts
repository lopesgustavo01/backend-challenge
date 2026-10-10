import { describe, expect, test } from "bun:test";
import { Money } from "@/shared/domain/money";
import { LedgerDirection } from "@/modules/wallet/domain/wallet-ledger-entry";
import { FailureCode } from "@/modules/wagering/domain/failure-code";
import {
  InvalidTransactionStateError,
  InvalidWagerTransactionError,
} from "@/modules/wagering/domain/wagering.errors";
import {
  CreateWagerTransactionProps,
  WagerTransaction,
  WagerTransactionKind as K,
  WagerTransactionStatus as S,
} from "@/modules/wagering/domain/wager-transaction";

const m = (amount: string, currency = "BRL") => Money.from({ amount, currency });
const at = new Date("2026-01-01T00:00:00Z");

let n = 0;
function props(overrides: Partial<CreateWagerTransactionProps> = {}): CreateWagerTransactionProps {
  n += 1;
  return {
    id: `tx${n}`,
    providerId: "provider-a",
    externalTransactionId: `ext${n}`,
    idempotencyKey: `provider-a:ext${n}`,
    payloadHash: "hash",
    walletId: "w1",
    playerId: "p1",
    roundId: "r1",
    gameId: "g1",
    kind: K.Bet,
    money: m("25.00"),
    createdAt: at,
    ...overrides,
  };
}
const make = (o: Partial<CreateWagerTransactionProps> = {}) => WagerTransaction.create(props(o));
const processed = (o: Partial<CreateWagerTransactionProps> = {}) => {
  const t = make(o);
  t.markProcessed(t.requiresReference() ? "resolved-ref" : undefined, at);
  return t;
};
const refundOf = (bet: WagerTransaction, o: Partial<CreateWagerTransactionProps> = {}) =>
  make({ kind: K.Refund, referenceExternalTransactionId: bet.externalTransactionId, ...o });

describe("criação", () => {
  test("nasce em PENDING", () => {
    const t = make();
    expect(t.status).toBe(S.Pending);
    expect(t.isTerminal()).toBe(false);
    expect(t.failureCode).toBeUndefined();
  });

  test("OPENING não pode ser criado pela entrada externa", () => {
    expect(() => make({ kind: K.Opening })).toThrow(InvalidWagerTransactionError);
  });

  test("createOpening é interno e gera CREDIT", () => {
    const { kind: _k, referenceExternalTransactionId: _r, ...rest } = props();
    const t = WagerTransaction.createOpening(rest);
    expect(t.kind).toBe(K.Opening);
    expect(t.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });

  test.each([[K.Refund], [K.Rollback]])("%s exige referência", (kind) => {
    expect(() => make({ kind })).toThrow(InvalidWagerTransactionError);
    expect(() => make({ kind, referenceExternalTransactionId: "" })).toThrow(InvalidWagerTransactionError);
  });

  test("BET não pode ter referência", () => {
    expect(() => make({ kind: K.Bet, referenceExternalTransactionId: "x" })).toThrow(InvalidWagerTransactionError);
  });

  test("WIN pode referenciar a BET (opcional)", () => {
    expect(() => make({ kind: K.Win })).not.toThrow();
    expect(() => make({ kind: K.Win, referenceExternalTransactionId: "bet1" })).not.toThrow();
  });

  test.each([[K.Bet], [K.Win], [K.Refund], [K.Rollback]])("%s com valor zero é rejeitado", (kind) => {
    expect(() => make({ kind, money: m("0.00"), referenceExternalTransactionId: "x" })).toThrow(InvalidWagerTransactionError);
  });

  test("LOSS aceita valor zero", () => {
    expect(() => make({ kind: K.Loss, money: m("0.00") })).not.toThrow();
  });
});

describe("consultas", () => {
  test("affectsBalance é false só para LOSS", () => {
    expect(make({ kind: K.Loss }).affectsBalance()).toBe(false);
    for (const kind of [K.Bet, K.Win]) expect(make({ kind }).affectsBalance()).toBe(true);
    for (const kind of [K.Refund, K.Rollback]) {
      expect(make({ kind, referenceExternalTransactionId: "x" }).affectsBalance()).toBe(true);
    }
  });

  test("requiresReference é true só para REFUND e ROLLBACK", () => {
    expect(make({ kind: K.Bet }).requiresReference()).toBe(false);
    expect(make({ kind: K.Win }).requiresReference()).toBe(false);
    expect(make({ kind: K.Refund, referenceExternalTransactionId: "x" }).requiresReference()).toBe(true);
    expect(make({ kind: K.Rollback, referenceExternalTransactionId: "x" }).requiresReference()).toBe(true);
  });

  test("matchesPayload compara o hash", () => {
    const t = make({ payloadHash: "abc" });
    expect(t.matchesPayload("abc")).toBe(true);
    expect(t.matchesPayload("xyz")).toBe(false);
  });
});

describe("transições", () => {
  test("PENDING -> PROCESSED registra processedAt e referência", () => {
    const t = make({ kind: K.Refund, referenceExternalTransactionId: "x" });
    t.markProcessed("internal-ref", at);
    expect(t.status).toBe(S.Processed);
    expect(t.referenceTransactionId).toBe("internal-ref");
    expect(t.processedAt).toEqual(at);
    expect(t.isTerminal()).toBe(true);
  });

  test("REFUND/ROLLBACK não podem ser processados sem referência resolvida", () => {
    const t = make({ kind: K.Rollback, referenceExternalTransactionId: "x" });
    expect(() => t.markProcessed(undefined, at)).toThrow(InvalidWagerTransactionError);
    expect(t.status).toBe(S.Pending);
  });

  test("PENDING -> PENDING_REFERENCE -> PROCESSED", () => {
    const t = make({ kind: K.Refund, referenceExternalTransactionId: "x" });
    t.markPendingReference();
    expect(t.status).toBe(S.PendingReference);
    expect(t.isTerminal()).toBe(false);
    t.markProcessed("ref", at);
    expect(t.status).toBe(S.Processed);
  });

  test("PENDING_REFERENCE -> REJECTED (referência nunca chegou)", () => {
    const t = make({ kind: K.Refund, referenceExternalTransactionId: "x" });
    t.markPendingReference();
    t.reject(FailureCode.ReferenceNotFound);
    expect(t.status).toBe(S.Rejected);
    expect(t.failureCode).toBe(FailureCode.ReferenceNotFound);
  });

  test("markPendingReference exige referência e só vale a partir de PENDING", () => {
    expect(() => make({ kind: K.Bet }).markPendingReference()).toThrow(InvalidWagerTransactionError);
    const t = make({ kind: K.Refund, referenceExternalTransactionId: "x" });
    t.markPendingReference();
    expect(() => t.markPendingReference()).toThrow(InvalidTransactionStateError);
  });

  test("reject só aceita códigos de negócio; fail só códigos de infra", () => {
    expect(() => make().reject(FailureCode.InternalError)).toThrow(InvalidWagerTransactionError);
    expect(() => make().fail(FailureCode.InsufficientFunds)).toThrow(InvalidWagerTransactionError);
    const t = make();
    t.fail(FailureCode.InternalError);
    expect(t.status).toBe(S.Failed);
    expect(t.failureCode).toBe(FailureCode.InternalError);
  });

  test("distingue saldo insuficiente de aposta e de reversão", () => {
    expect(FailureCode.InsufficientFunds).not.toBe(FailureCode.ReversalInsufficientFunds);
  });

  describe.each([
    ["PROCESSED", (t: WagerTransaction) => t.markProcessed(undefined, at)],
    ["REJECTED", (t: WagerTransaction) => t.reject(FailureCode.InsufficientFunds)],
    ["FAILED", (t: WagerTransaction) => t.fail(FailureCode.InternalError)],
  ])("estado terminal %s", (_name, toTerminal) => {
    test("não aceita nenhuma outra transição", () => {
      const t = make();
      toTerminal(t);
      const before = t.status;
      expect(() => t.markProcessed(undefined, at)).toThrow(InvalidTransactionStateError);
      expect(() => t.reject(FailureCode.InsufficientFunds)).toThrow(InvalidTransactionStateError);
      expect(() => t.fail(FailureCode.InternalError)).toThrow(InvalidTransactionStateError);
      expect(() => t.markPendingReference()).toThrow(InvalidTransactionStateError);
      expect(t.status).toBe(before);
    });
  });
});

describe("ledgerDirectionFor", () => {
  test("BET -> DEBIT; WIN e REFUND -> CREDIT", () => {
    expect(make({ kind: K.Bet }).ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(make({ kind: K.Win }).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(make({ kind: K.Refund, referenceExternalTransactionId: "x" }).ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });

  test("ROLLBACK inverte a direção da referência", () => {
    const rb = make({ kind: K.Rollback, referenceExternalTransactionId: "x" });
    expect(rb.ledgerDirectionFor(processed({ kind: K.Bet }))).toBe(LedgerDirection.Credit);
    expect(rb.ledgerDirectionFor(processed({ kind: K.Win }))).toBe(LedgerDirection.Debit);
    expect(rb.ledgerDirectionFor(processed({ kind: K.Refund, referenceExternalTransactionId: "b" }))).toBe(
      LedgerDirection.Debit,
    );
  });

  test("ROLLBACK sem referência ou sobre tipo inválido lança", () => {
    const rb = make({ kind: K.Rollback, referenceExternalTransactionId: "x" });
    expect(() => rb.ledgerDirectionFor()).toThrow(InvalidWagerTransactionError);
    expect(() => rb.ledgerDirectionFor(processed({ kind: K.Loss }))).toThrow(InvalidWagerTransactionError);
  });

  test("LOSS não gera lançamento", () => {
    expect(() => make({ kind: K.Loss }).ledgerDirectionFor()).toThrow(InvalidWagerTransactionError);
  });
});

describe("validateReference", () => {
  test("REFUND de BET processada, mesmo escopo e valor: válido", () => {
    const bet = processed();
    expect(refundOf(bet).validateReference(bet)).toBeUndefined();
  });

  test("referência não processada", () => {
    const bet = make();
    expect(refundOf(bet).validateReference(bet)).toBe(FailureCode.ReferenceNotProcessed);
    const rejected = make();
    rejected.reject(FailureCode.InsufficientFunds);
    expect(refundOf(rejected).validateReference(rejected)).toBe(FailureCode.ReferenceNotProcessed);
  });

  test.each([
    ["provider", { providerId: "provider-b" }],
    ["player", { playerId: "p2" }],
    ["wallet", { walletId: "w2" }],
    ["rodada", { roundId: "r2" }],
  ])("%s diferente => REFERENCE_MISMATCH", (_n, diff) => {
    const bet = processed();
    expect(refundOf(bet, diff).validateReference(bet)).toBe(FailureCode.ReferenceMismatch);
  });

  test("moeda diferente da referência => REFERENCE_MISMATCH", () => {
    const bet = processed();
    expect(refundOf(bet, { money: m("25.00", "USD") }).validateReference(bet)).toBe(FailureCode.ReferenceMismatch);
  });

  test("REFUND só referencia BET", () => {
    const win = processed({ kind: K.Win });
    expect(refundOf(win).validateReference(win)).toBe(FailureCode.InvalidReferenceKind);
  });

  test("ROLLBACK referencia BET, WIN ou REFUND; não LOSS nem ROLLBACK", () => {
    const rollbackOf = (ref: WagerTransaction) =>
      make({ kind: K.Rollback, referenceExternalTransactionId: ref.externalTransactionId });
    const bet = processed();
    const win = processed({ kind: K.Win });
    const refund = processed({ kind: K.Refund, referenceExternalTransactionId: "b" });
    for (const ref of [bet, win, refund]) expect(rollbackOf(ref).validateReference(ref)).toBeUndefined();

    const loss = processed({ kind: K.Loss });
    const rb = processed({ kind: K.Rollback, referenceExternalTransactionId: "b" });
    expect(rollbackOf(loss).validateReference(loss)).toBe(FailureCode.InvalidReferenceKind);
    expect(rollbackOf(rb).validateReference(rb)).toBe(FailureCode.InvalidReferenceKind);
  });

  test("valor diferente => AMOUNT_MISMATCH (reversão parcial fora de escopo)", () => {
    const bet = processed({ money: m("25.00") });
    expect(refundOf(bet, { money: m("10.00") }).validateReference(bet)).toBe(FailureCode.AmountMismatch);
  });

  test("operações sem referência obrigatória não validam nada", () => {
    expect(make({ kind: K.Bet }).validateReference(processed())).toBeUndefined();
  });
});

describe("rehydrate", () => {
  test("reconstrói estado terminal sem revalidar transições", () => {
    const t = WagerTransaction.rehydrate({
      ...props(),
      status: S.Rejected,
      failureCode: FailureCode.InsufficientFunds,
    });
    expect(t.isTerminal()).toBe(true);
    expect(t.failureCode).toBe(FailureCode.InsufficientFunds);
  });
});
