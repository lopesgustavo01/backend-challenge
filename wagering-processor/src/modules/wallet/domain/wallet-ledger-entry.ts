import { Money } from "@/shared/domain/money";
import { CurrencyMismatchError } from "@/shared/domain/errors";
import { InvalidLedgerEntryError } from "./wallet.errors";

export enum LedgerDirection {
  Debit = "DEBIT",
  Credit = "CREDIT",
}

export interface CreateLedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

/** Estado persistido; a reidratação não revalida. */
export type LedgerEntryState = CreateLedgerEntryProps;

/**
 * Lançamento imutável: todos os campos são readonly e não há métodos de transição.
 * No banco, a imutabilidade é reforçada por trigger (nunca só por convenção de código).
 */
export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly createdAt: Date,
  ) {}

  /** Valida a aritmética: before ± money === after, e nenhum saldo negativo. */
  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    const { money, balanceBefore, balanceAfter } = props;

    // lança CurrencyMismatchError se as moedas divergirem
    for (const m of [balanceBefore, balanceAfter]) {
      if (m.currency !== money.currency)
        throw new CurrencyMismatchError(money.currency, m.currency);
    }
    if (!money.isPositive()) {
      throw new InvalidLedgerEntryError(
        "Ledger entry amount must be strictly positive",
      );
    }
    if (balanceBefore.isNegative() || balanceAfter.isNegative()) {
      throw new InvalidLedgerEntryError(
        "Ledger entry cannot involve a negative balance",
      );
    }

    const entry = WalletLedgerEntry.rehydrate(props);
    if (!entry.isBalanced()) {
      throw new InvalidLedgerEntryError(
        `Unbalanced entry: ${balanceBefore} ${props.direction} ${money} !== ${balanceAfter}`,
      );
    }
    return entry;
  }

  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      state.createdAt,
    );
  }

  /** balanceBefore ± money === balanceAfter. */
  isBalanced(): boolean {
    const expected =
      this.direction === LedgerDirection.Credit
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money);
    return expected.equals(this.balanceAfter);
  }
}
