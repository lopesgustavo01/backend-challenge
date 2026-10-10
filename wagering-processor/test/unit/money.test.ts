import { describe, expect, test } from "bun:test";
import { Money } from "@/shared/domain/money";
import { CurrencyMismatchError, InvalidMoneyError } from "@/shared/domain/errors";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
const usd = (amount: string) => Money.from({ amount, currency: "USD" });

describe("Money.from", () => {
  test.each([
    ["25.00", "25.00"],
    ["25", "25.00"],
    ["25.5", "25.50"],
    ["0", "0.00"],
    ["0.01", "0.01"],
    ["99999999999999999.99", "99999999999999999.99"],
  ])("aceita %s e serializa como %s", (input, expected) => {
    expect(brl(input).toJSON()).toEqual({ amount: expected, currency: "BRL" });
  });

  test.each([
    [""],
    [" "],
    ["NaN"],
    ["Infinity"],
    ["-Infinity"],
    ["1e5"],
    ["1E5"],
    ["0x10"],
    ["-1.00"],
    ["+1.00"],
    ["1.005"],
    ["1.234"],
    [".5"],
    ["1."],
    ["1,50"],
    [" 1.00"],
    ["1.00 "],
    ["100000000000000000.00"], // 18 dígitos inteiros: acima de NUMERIC(19,2)
  ])("rejeita amount inválido %p", (amount) => {
    expect(() => brl(amount)).toThrow(InvalidMoneyError);
  });

  test("rejeita amount que não é string (number, null, undefined)", () => {
    for (const amount of [25, Number.NaN, null, undefined]) {
      expect(() => Money.from({ amount: amount as unknown as string, currency: "BRL" })).toThrow(InvalidMoneyError);
    }
  });

  test.each([["brl"], ["BR"], ["BRLL"], [""], ["R$ "]])("rejeita currency inválida %p", (currency) => {
    expect(() => Money.from({ amount: "1.00", currency })).toThrow(InvalidMoneyError);
  });
});

describe("aritmética", () => {
  test("é exata (0.10 + 0.20 === 0.30)", () => {
    expect(brl("0.10").add(brl("0.20")).toJSON().amount).toBe("0.30");
    expect(brl("0.30").subtract(brl("0.10")).toJSON().amount).toBe("0.20");
  });

  test("é imutável: operações devolvem nova instância", () => {
    const a = brl("100.00");
    const b = a.subtract(brl("30.00"));
    expect(a.toJSON().amount).toBe("100.00");
    expect(b.toJSON().amount).toBe("70.00");
    expect(b).not.toBe(a);
  });

  test("subtract pode ficar negativo; negate inverte o sinal", () => {
    const r = brl("20.00").subtract(brl("80.00"));
    expect(r.isNegative()).toBe(true);
    expect(r.toJSON().amount).toBe("-60.00");
    expect(r.negate().toJSON().amount).toBe("60.00");
  });

  test("zero nunca serializa como -0.00", () => {
    expect(Money.zero("BRL").negate().toJSON().amount).toBe("0.00");
    expect(brl("5.00").subtract(brl("5.00")).toJSON().amount).toBe("0.00");
  });

  test("overflow acima da faixa suportada é rejeitado", () => {
    const max = brl("99999999999999999.99");
    expect(() => max.add(brl("0.01"))).toThrow(InvalidMoneyError);
  });
});

describe("consultas", () => {
  test("isZero / isPositive / isNegative", () => {
    expect(Money.zero("BRL").isZero()).toBe(true);
    expect(Money.zero("BRL").isPositive()).toBe(false);
    expect(brl("0.01").isPositive()).toBe(true);
    expect(brl("0.01").negate().isNegative()).toBe(true);
  });

  test("isLessThan", () => {
    expect(brl("20.00").isLessThan(brl("80.00"))).toBe(true);
    expect(brl("80.00").isLessThan(brl("80.00"))).toBe(false);
  });

  test("equals compara valor e moeda, sem lançar", () => {
    expect(brl("25").equals(brl("25.00"))).toBe(true);
    expect(brl("25.00").equals(brl("25.01"))).toBe(false);
    expect(brl("25.00").equals(usd("25.00"))).toBe(false);
  });

  test("toString e round-trip toJSON -> from", () => {
    expect(brl("1234.5").toString()).toBe("1234.50 BRL");
    const m = brl("42.10");
    expect(Money.from(m.toJSON()).equals(m)).toBe(true);
    expect(JSON.stringify({ m })).toBe('{"m":{"amount":"42.10","currency":"BRL"}}');
  });
});

describe("conflito de moeda", () => {
  test("add, subtract e isLessThan lançam CurrencyMismatchError", () => {
    expect(() => brl("1.00").add(usd("1.00"))).toThrow(CurrencyMismatchError);
    expect(() => brl("1.00").subtract(usd("1.00"))).toThrow(CurrencyMismatchError);
    expect(() => brl("1.00").isLessThan(usd("1.00"))).toThrow(CurrencyMismatchError);
  });
});
