import Decimal from "decimal.js";
import { CurrencyMismatchError, InvalidMoneyError } from "./errors";

// Decimal isolado: não depende de configuração global alterada por terceiros.
const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_EVEN });
type Dec = InstanceType<typeof D>;

/** Compatível com NUMERIC(19,2): até 17 dígitos inteiros + 2 decimais. */
const AMOUNT_PATTERN = /^\d{1,17}(\.\d{1,2})?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const SCALE = 2;
const LIMIT = new D("1e17");

export interface MoneyProps {
  amount: string; // decimal string, ex.: "25.00"
  currency: string; // ISO-4217
}

export class Money {
  private constructor(
    private readonly value: Dec,
    public readonly currency: string,
  ) {}

  /**
   * Fronteira de entrada (API/fila): aceita só string decimal não negativa com
   * 0 a 2 casas (ex.: "25", "25.5", "25.00"). Rejeita number, NaN, Infinity,
   * notação científica, vazio, sinal e mais de 2 casas.
   */
  static from(props: MoneyProps): Money {
    const { amount, currency } = props ?? ({} as MoneyProps);
    Money.assertCurrency(currency);
    if (typeof amount !== "string" || !AMOUNT_PATTERN.test(amount)) {
      throw new InvalidMoneyError("Invalid amount: expected non-negative decimal string with up to 2 decimals");
    }
    return new Money(new D(amount), currency);
  }

  static zero(currency: string): Money {
    Money.assertCurrency(currency);
    return new Money(new D(0), currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.of(this.value.plus(other.value), this.currency);
  }

  /** Pode resultar em valor negativo; quem aplica a regra de saldo decide o que fazer. */
  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.of(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return Money.of(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.gt(0);
  }

  isNegative(): boolean {
    return this.value.lt(0);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lt(other.value);
  }

  /** Moedas diferentes nunca são iguais (não lança). */
  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.eq(other.value);
  }

  toJSON(): MoneyProps {
    return { amount: this.value.toFixed(SCALE), currency: this.currency };
  }

  toString(): string {
    return `${this.value.toFixed(SCALE)} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  private static assertCurrency(currency: unknown): asserts currency is string {
    if (typeof currency !== "string" || !CURRENCY_PATTERN.test(currency)) {
      throw new InvalidMoneyError("Invalid currency: expected ISO-4217 code (e.g. BRL)");
    }
  }

  /** Construção interna (resultados de aritmética): permite negativo, normaliza -0 e limita a faixa. */
  private static of(value: Dec, currency: string): Money {
    if (value.abs().gte(LIMIT)) {
      throw new InvalidMoneyError("Amount out of supported range");
    }
    return new Money(value.isZero() ? new D(0) : value, currency);
  }
}
