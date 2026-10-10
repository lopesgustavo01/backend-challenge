import { describe, expect, test } from "bun:test";
import { Money } from "@/shared/domain/money";
import { CurrencyMismatchError } from "@/shared/domain/errors";
import { LedgerDirection, WalletLedgerEntry } from "@/modules/wallet/domain/wallet-ledger-entry";
import { InvalidLedgerEntryError } from "@/modules/wallet/domain/wallet.errors";

const m = (amount: string, currency = "BRL") => Money.from({ amount, currency });
const base = {
  id: "e1",
  walletId: "w1",
  transactionId: "t1",
  createdAt: new Date("2026-01-01T00:00:00Z"),
};

describe("WalletLedgerEntry.create", () => {
  test("aceita débito balanceado", () => {
    const e = WalletLedgerEntry.create({
      ...base,
      direction: LedgerDirection.Debit,
      money: m("25.00"),
      balanceBefore: m("100.00"),
      balanceAfter: m("75.00"),
    });
    expect(e.isBalanced()).toBe(true);
  });

  test("aceita crédito balanceado", () => {
    const e = WalletLedgerEntry.create({
      ...base,
      direction: LedgerDirection.Credit,
      money: m("25.00"),
      balanceBefore: m("0.00"),
      balanceAfter: m("25.00"),
    });
    expect(e.isBalanced()).toBe(true);
  });

  test("rejeita aritmética inconsistente", () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Debit,
        money: m("25.00"),
        balanceBefore: m("100.00"),
        balanceAfter: m("80.00"),
      }),
    ).toThrow(InvalidLedgerEntryError);
  });

  test("rejeita direção invertida (débito que aumenta saldo)", () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Debit,
        money: m("25.00"),
        balanceBefore: m("100.00"),
        balanceAfter: m("125.00"),
      }),
    ).toThrow(InvalidLedgerEntryError);
  });

  test("rejeita valor zero", () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Credit,
        money: m("0.00"),
        balanceBefore: m("10.00"),
        balanceAfter: m("10.00"),
      }),
    ).toThrow(InvalidLedgerEntryError);
  });

  test("rejeita saldo negativo", () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Debit,
        money: m("80.00"),
        balanceBefore: m("20.00"),
        balanceAfter: m("20.00").subtract(m("80.00")),
      }),
    ).toThrow(InvalidLedgerEntryError);
  });

  test("rejeita moedas divergentes", () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Credit,
        money: m("10.00", "USD"),
        balanceBefore: m("0.00"),
        balanceAfter: m("10.00"),
      }),
    ).toThrow(CurrencyMismatchError);
  });
});

describe("imutabilidade estrutural", () => {
  test("não expõe métodos de transição", () => {
    const e = WalletLedgerEntry.rehydrate({
      ...base,
      direction: LedgerDirection.Credit,
      money: m("1.00"),
      balanceBefore: m("0.00"),
      balanceAfter: m("1.00"),
    });
    const proto = Object.getOwnPropertyNames(Object.getPrototypeOf(e)).filter((n) => n !== "constructor");
    expect(proto).toEqual(["isBalanced"]);
  });

  test("rehydrate não revalida (reconstrói estado persistido)", () => {
    const e = WalletLedgerEntry.rehydrate({
      ...base,
      direction: LedgerDirection.Debit,
      money: m("25.00"),
      balanceBefore: m("100.00"),
      balanceAfter: m("80.00"),
    });
    expect(e.isBalanced()).toBe(false); // detecta corrupção sem lançar
  });
});
