import { DomainError } from "@/shared/domain/errors";

/** Tentativa de transição inválida: erro de programação, não caminho de negócio. */
export class InvalidTransactionStateError extends DomainError {
  readonly code = "INVALID_TRANSACTION_STATE";
}

/** Dados inconsistentes na criação/uso da transação (ex.: REFUND sem referência). */
export class InvalidWagerTransactionError extends DomainError {
  readonly code = "INVALID_WAGER_TRANSACTION";
}
