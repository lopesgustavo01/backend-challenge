import { Money } from "@/shared/domain/money";
import { CurrencyMismatchError } from "@/shared/domain/errors";
import {
  InsufficientFundsError,
  InvalidAmountError,
  InvalidWalletError,
} from "./wallet.errors";
import { LedgerDirection, WalletLedgerEntry } from "./wallet-ledger-entry";

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

/** Dados de contexto da movimentação, fornecidos pelo use case (o domínio não gera ids nem lê relógio). */
export interface MovementContext {
  entryId: string;
  transactionId: string;
  at: Date;
}

/**
 * Aggregate root. O domínio garante: moeda igual, valor positivo, saldo nunca negativo,
 * e que toda mudança de saldo devolve o lançamento correspondente.
 *
 * Ele NÃO garante exclusão mútua entre processos: isso é do lock da linha no banco
 * (SELECT ... FOR UPDATE) mais o CHECK (balance >= 0).
 */
export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  /**
   * Abre a wallet já com o saldo inicial e version 1.
   * Se o saldo for > 0, o use case registra a transação OPENING e o lançamento CREDIT
   * (balanceBefore = 0) na mesma transação SQL.
   */
  static open(props: {
    id: string;
    playerId: string;
    initialBalance: Money;
    at: Date;
  }): Wallet {
    if (props.initialBalance.isNegative()) {
      throw new InvalidWalletError("Initial balance cannot be negative");
    }
    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      props.at,
      props.at,
    );
  }

  /** Reconstrução a partir da persistência — não revalida transições. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  /** Debita e devolve o lançamento. Lança InsufficientFundsError se o saldo não cobrir. */
  debit(money: Money, ctx: MovementContext): WalletLedgerEntry {
    this.assertMovable(money);
    if (this._balance.isLessThan(money)) {
      throw new InsufficientFundsError(
        this._balance.toString(),
        money.toString(),
      );
    }
    return this.apply(
      LedgerDirection.Debit,
      this._balance.subtract(money),
      money,
      ctx,
    );
  }

  credit(money: Money, ctx: MovementContext): WalletLedgerEntry {
    this.assertMovable(money);
    return this.apply(
      LedgerDirection.Credit,
      this._balance.add(money),
      money,
      ctx,
    );
  }

  private apply(
    direction: LedgerDirection,
    after: Money,
    money: Money,
    ctx: MovementContext,
  ): WalletLedgerEntry {
    // Cria o lançamento ANTES de mutar: se a criação falhar, a wallet não muda.
    const entry = WalletLedgerEntry.create({
      id: ctx.entryId,
      walletId: this.id,
      transactionId: ctx.transactionId,
      direction,
      money,
      balanceBefore: this._balance,
      balanceAfter: after,
      createdAt: ctx.at,
    });
    this._balance = after;
    this._version += 1; // só incrementa quando o saldo muda
    this._updatedAt = ctx.at;
    return entry;
  }

  private assertMovable(money: Money): void {
    this.assertSameCurrency(money);
    if (!money.isPositive()) {
      throw new InvalidAmountError("Movement amount must be strictly positive");
    }
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}
