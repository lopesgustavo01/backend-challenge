import { describe, expect, test } from "bun:test";
import { Money } from "@/shared/domain/money";
import { CurrencyMismatchError } from "@/shared/domain/errors";
import { Wallet } from "@/modules/wallet/domain/wallet";
import { LedgerDirection } from "@/modules/wallet/domain/wallet-ledger-entry";
import { InsufficientFundsError, InvalidAmountError, InvalidWalletError } from "@/modules/wallet/domain/wallet.errors";

const m = (amount: string, currency = "BRL") => Money.from({ amount, currency });
const at = new Date("2026-01-01T00:00:00Z");
const ctx = (n = 1) => ({ entryId: `e${n}`, transactionId: `t${n}`, at: new Date(at.getTime() + n) });
const open = (balance = "100.00") => Wallet.open({ id: "w1", playerId: "p1", initialBalance: m(balance), at });

describe("Wallet.open", () => {
  test("version 1, moeda e saldo iniciais", () => {
    const w = open("1000.00");
    expect(w.version).toBe(1);
    expect(w.currency).toBe("BRL");
    expect(w.balance.toJSON()).toEqual({ amount: "1000.00", currency: "BRL" });
  });

  test("aceita saldo inicial zero", () => {
    expect(open("0.00").balance.isZero()).toBe(true);
  });

  test("rejeita saldo inicial negativo", () => {
    expect(() => Wallet.open({ id: "w", playerId: "p", initialBalance: m("1.00").negate(), at })).toThrow(
      InvalidWalletError,
    );
  });
});

describe("debit", () => {
  test("debita, devolve lançamento e incrementa version", () => {
    const w = open("100.00");
    const e = w.debit(m("25.00"), ctx());
    expect(w.balance.toJSON().amount).toBe("75.00");
    expect(w.version).toBe(2);
    expect(e.direction).toBe(LedgerDirection.Debit);
    expect(e.balanceBefore.toJSON().amount).toBe("100.00");
    expect(e.balanceAfter.toJSON().amount).toBe("75.00");
    expect(e.walletId).toBe("w1");
    expect(e.isBalanced()).toBe(true);
  });

  test("permite zerar o saldo exatamente", () => {
    const w = open("80.00");
    w.debit(m("80.00"), ctx());
    expect(w.balance.isZero()).toBe(true);
  });

  test("saldo insuficiente lança e NÃO altera wallet", () => {
    const w = open("20.00");
    expect(() => w.debit(m("80.00"), ctx())).toThrow(InsufficientFundsError);
    expect(w.balance.toJSON().amount).toBe("20.00");
    expect(w.version).toBe(1);
  });

  test("cenário da seção 8: 100,00 e duas apostas de 80,00 (sequencial) => uma passa, saldo 20,00", () => {
    const w = open("100.00");
    const results = [1, 2].map((n) => {
      try {
        return w.debit(m("80.00"), ctx(n));
      } catch (err) {
        return err;
      }
    });
    expect(results.filter((r) => r instanceof InsufficientFundsError)).toHaveLength(1);
    expect(w.balance.toJSON().amount).toBe("20.00");
  });
});

describe("credit", () => {
  test("credita, devolve lançamento e incrementa version", () => {
    const w = open("100.00");
    const e = w.credit(m("50.00"), ctx());
    expect(w.balance.toJSON().amount).toBe("150.00");
    expect(w.version).toBe(2);
    expect(e.direction).toBe(LedgerDirection.Credit);
    expect(e.isBalanced()).toBe(true);
  });
});

describe("validações comuns", () => {
  test("moeda diferente da wallet lança CurrencyMismatchError e não muda estado", () => {
    const w = open("100.00");
    expect(() => w.debit(m("1.00", "USD"), ctx())).toThrow(CurrencyMismatchError);
    expect(() => w.credit(m("1.00", "USD"), ctx())).toThrow(CurrencyMismatchError);
    expect(w.version).toBe(1);
  });

  test("valor zero ou negativo lança InvalidAmountError", () => {
    const w = open("100.00");
    expect(() => w.debit(m("0.00"), ctx())).toThrow(InvalidAmountError);
    expect(() => w.credit(m("1.00").negate(), ctx())).toThrow(InvalidAmountError);
    expect(w.version).toBe(1);
  });

  test("invariante: saldo final == saldo inicial + soma dos lançamentos", () => {
    const w = open("100.00");
    const entries = [w.debit(m("30.00"), ctx(1)), w.credit(m("5.50"), ctx(2)), w.debit(m("10.25"), ctx(3))];
    const rebuilt = entries.reduce(
      (acc, e) => (e.direction === LedgerDirection.Credit ? acc.add(e.money) : acc.subtract(e.money)),
      m("100.00"),
    );
    expect(rebuilt.equals(w.balance)).toBe(true);
    expect(w.version).toBe(4);
  });

  test("updatedAt acompanha a última movimentação", () => {
    const w = open();
    const c = ctx(5);
    w.credit(m("1.00"), c);
    expect(w.updatedAt).toEqual(c.at);
  });
});

describe("Wallet.rehydrate", () => {
  test("reconstrói estado sem alterar version", () => {
    const w = Wallet.rehydrate({
      id: "w9",
      playerId: "p9",
      currency: "BRL",
      balance: m("42.00"),
      version: 7,
      createdAt: at,
      updatedAt: at,
    });
    expect(w.version).toBe(7);
    expect(w.balance.toJSON().amount).toBe("42.00");
  });
});
