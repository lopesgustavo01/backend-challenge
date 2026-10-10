/**
 * Taxonomia estável e legível por máquina. Ajuda o provedor a decidir o que fazer:
 *  - corrigir payload / desistir: rejeições de negócio
 *  - reenviar depois: INTERNAL_ERROR (erro permanente de infra, FAILED)
 */
export enum FailureCode {
  // ---- rejeições de negócio (status REJECTED)
  InsufficientFunds = "INSUFFICIENT_FUNDS", // BET sem saldo
  ReversalInsufficientFunds = "REVERSAL_INSUFFICIENT_FUNDS", // reversão deixaria saldo negativo
  ReferenceNotFound = "REFERENCE_NOT_FOUND", // referência não apareceu após limite/TTL
  ReferenceNotProcessed = "REFERENCE_NOT_PROCESSED", // referência existe mas foi REJECTED/FAILED
  ReferenceMismatch = "REFERENCE_MISMATCH", // outro provider/player/wallet/moeda/rodada
  InvalidReferenceKind = "INVALID_REFERENCE_KIND", // REFUND de não-BET; ROLLBACK de tipo inválido
  AlreadyReversed = "ALREADY_REVERSED", // referência já revertida por este tipo de operação
  AmountMismatch = "AMOUNT_MISMATCH", // valor != valor da referência
  CurrencyMismatch = "CURRENCY_MISMATCH", // moeda != moeda da wallet

  // ---- falhas permanentes de infraestrutura (status FAILED)
  InternalError = "INTERNAL_ERROR",
}

const INFRA_CODES: ReadonlySet<FailureCode> = new Set([FailureCode.InternalError]);

export function isInfrastructureFailure(code: FailureCode): boolean {
  return INFRA_CODES.has(code);
}
