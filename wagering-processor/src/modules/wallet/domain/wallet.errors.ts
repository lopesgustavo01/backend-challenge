import { DomainError } from "@/shared/domain/errors";

export class InsufficientFundsError extends DomainError {
  readonly code = "INSUFFICIENT_FUNDS";

  constructor(
    public readonly balance: string,
    public readonly requested: string,
  ) {
    super(`Insufficient funds: balance ${balance}, requested ${requested}`);
  }
}

/** Valor de movimentação precisa ser estritamente positivo. */
export class InvalidAmountError extends DomainError {
  readonly code = "INVALID_AMOUNT";
}

export class InvalidLedgerEntryError extends DomainError {
  readonly code = "INVALID_LEDGER_ENTRY";
}

export class InvalidWalletError extends DomainError {
  readonly code = "INVALID_WALLET";
}
