import { Wallet } from "@/modules/wallet/domain/wallet";
import { LedgerPageItem, StoredWagerTransaction } from "@/modules/wagering/application/ports";
import { WagerTransactionResult } from "@/modules/wagering/application/process-wager-transaction.use-case";
import { WagerTransactionStatus } from "@/modules/wagering/domain/wager-transaction";

/**
 * Mapa de status HTTP do POST /wagering/transactions (decisão documentada no ARCHITECTURE.md):
 *   200 processada (ou replay)         o provedor pode seguir
 *   202 PENDING_REFERENCE              aceita; aguardando a transação referenciada. Não reenviar
 *   422 REJECTED                       regra de negócio; ver failureCode. Reenviar a mesma coisa dá o mesmo resultado
 *   500 FAILED                         erro permanente de infraestrutura
 * Erros que não viram transação (400, 404, 409, 422 de player/moeda, 503) saem pelo AppExceptionFilter.
 */
export function statusForResult(status: WagerTransactionStatus): number {
  switch (status) {
    case WagerTransactionStatus.Processed:
      return 200;
    case WagerTransactionStatus.PendingReference:
    case WagerTransactionStatus.Pending:
      return 202;
    case WagerTransactionStatus.Rejected:
      return 422;
    case WagerTransactionStatus.Failed:
      return 500;
  }
}

export function submitView(result: WagerTransactionResult) {
  return {
    transactionId: result.transactionId,
    status: result.status,
    failureCode: result.failureCode,
    balance: result.balance,
    idempotentReplay: result.idempotentReplay,
  };
}

export function walletView(wallet: Wallet) {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    balance: wallet.balance.toJSON(),
    version: wallet.version,
    createdAt: wallet.createdAt.toISOString(),
    updatedAt: wallet.updatedAt.toISOString(),
  };
}

export function ledgerEntryView({ entry }: LedgerPageItem) {
  return {
    id: entry.id,
    transactionId: entry.transactionId,
    direction: entry.direction,
    money: entry.money.toJSON(),
    balanceBefore: entry.balanceBefore.toJSON(),
    balanceAfter: entry.balanceAfter.toJSON(),
    createdAt: entry.createdAt.toISOString(),
  };
}

export function transactionView({ transaction: t, balanceAfter }: StoredWagerTransaction) {
  return {
    id: t.id,
    providerId: t.providerId,
    externalTransactionId: t.externalTransactionId,
    walletId: t.walletId,
    playerId: t.playerId,
    roundId: t.roundId,
    gameId: t.gameId,
    kind: t.kind,
    money: t.money.toJSON(),
    status: t.status,
    failureCode: t.failureCode,
    referenceExternalTransactionId: t.referenceExternalTransactionId,
    referenceTransactionId: t.referenceTransactionId,
    balance: balanceAfter?.toJSON(),
    createdAt: t.createdAt.toISOString(),
    processedAt: t.processedAt?.toISOString(),
  };
}
