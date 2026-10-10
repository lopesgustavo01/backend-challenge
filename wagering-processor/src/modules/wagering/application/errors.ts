import { DomainError } from "@/shared/domain/errors";

/** Payload/comando inválido: nada é persistido. O provedor deve corrigir. */
export class InvalidCommandError extends DomainError {
  readonly code = "INVALID_PAYLOAD";
}

/** Mesma idempotency key com payload diferente, ou mesmo (provider, external id) com outra key. */
export class IdempotencyConflictError extends DomainError {
  readonly code = "IDEMPOTENCY_CONFLICT";
}

export class WalletNotFoundError extends DomainError {
  readonly code = "WALLET_NOT_FOUND";
}

export class TransactionNotFoundError extends DomainError {
  readonly code = "TRANSACTION_NOT_FOUND";
}

export class WalletAlreadyExistsError extends DomainError {
  readonly code = "WALLET_ALREADY_EXISTS";
}

/**
 * Player ou moeda do comando não bate com a wallet. Não é persistido: as FKs compostas do schema
 * impedem gravar uma transação inconsistente com a wallet.
 */
export class WalletMismatchError extends DomainError {
  constructor(
    public readonly code: "CURRENCY_MISMATCH" | "PLAYER_MISMATCH",
    message: string,
  ) {
    super(message);
  }
}

/** Condição transitória (UPDATE otimista sem linha, deadlock, indisponibilidade): reenviar é seguro. */
export class TransientProcessingError extends DomainError {
  readonly code = "TRANSIENT_FAILURE";
}

export function isTransientProcessingError(error: unknown): boolean {
  return error instanceof TransientProcessingError;
}
