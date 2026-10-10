import { Money } from "@/shared/domain/money";
import { Clock, IdGenerator } from "@/shared/application/ports";
import { EventContext } from "@/shared/messaging/integration-event";
import { OutboxMessage } from "@/shared/messaging/outbox-message";
import { Wallet } from "@/modules/wallet/domain/wallet";
import { LedgerDirection, WalletLedgerEntry } from "@/modules/wallet/domain/wallet-ledger-entry";
import { FailureCode } from "../domain/failure-code";
import { WagerTransaction, WagerTransactionKind as K, WagerTransactionStatus as S } from "../domain/wager-transaction";
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from "../domain/events/wager-events";
import { TransactionExtras, WageringRepositories } from "./ports";

export interface PendingReferencePolicy {
  /** Atraso da 1ª reprocessagem; dobra a cada tentativa até maxDelayMs. */
  baseDelayMs: number;
  maxDelayMs: number;
  /** Esgotado qualquer um dos dois limites: REJECTED com REFERENCE_NOT_FOUND. */
  maxAttempts: number;
  ttlMs: number;
}

export const DEFAULT_PENDING_REFERENCE_POLICY: PendingReferencePolicy = {
  baseDelayMs: 2_000,
  maxDelayMs: 60_000,
  maxAttempts: 8,
  ttlMs: 10 * 60_000,
};

export type SettleMode = "insert" | "update";

export interface SettlementResult {
  /** Só em mode "insert": outra requisição ganhou a corrida pela idempotency key. Nada foi gravado. */
  raced: boolean;
  /** Reprocessagem (mode "update") em que a referência continua ausente: nada mudou. */
  stillPending: boolean;
  status: S;
  balanceAfter?: Money;
}

interface Decision {
  entry?: WalletLedgerEntry;
  extras: TransactionExtras;
  unchanged?: boolean;
}

/**
 * Decide o destino de uma transação com a wallet JÁ TRAVADA (FOR UPDATE) e a persiste junto
 * com ledger e outbox. Compartilhado pela entrada HTTP/SQS (insert) e pelo worker de
 * PENDING_REFERENCE (update).
 *
 * Fase 1 (decide): só leituras + mutação em memória de `tx` e `wallet`.
 * Fase 2 (persiste): claim da idempotency key primeiro, depois saldo, ledger e outbox.
 */
export class WagerSettlement {
  constructor(
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly policy: PendingReferencePolicy = DEFAULT_PENDING_REFERENCE_POLICY,
  ) {}

  async settle(
    repos: WageringRepositories,
    wallet: Wallet,
    tx: WagerTransaction,
    mode: SettleMode,
    correlationId: string,
  ): Promise<SettlementResult> {
    const now = this.clock.now();
    const versionBefore = wallet.version;
    const decision = await this.decide(repos, wallet, tx, now);

    if (decision.unchanged) {
      return { raced: false, stillPending: true, status: tx.status };
    }

    if (mode === "insert") {
      const inserted = await repos.transactions.insertIfAbsent(tx, decision.extras);
      if (!inserted) return { raced: true, stillPending: false, status: tx.status };
    } else {
      await repos.transactions.update(tx, decision.extras);
    }

    if (decision.entry) {
      await repos.wallets.saveBalance(wallet, versionBefore);
      await repos.ledger.append(decision.entry);
    }

    await repos.outbox.enqueue(this.events(tx, wallet, decision, correlationId, now));
    return { raced: false, stillPending: false, status: tx.status, balanceAfter: decision.extras.balanceAfter };
  }

  /**
   * Reprocessagem de PENDING_REFERENCE em que a referência continua ausente (ou ela própria pendente), ou em que
   * o processamento falhou por erro inesperado. Com a wallet já travada:
   *   - dentro dos limites: agenda a próxima tentativa (backoff exponencial, teto maxDelayMs)
   *   - maxAttempts ou ttl esgotados: REJECTED/REFERENCE_NOT_FOUND (ou REFERENCE_NOT_PROCESSED se ela existe
   *     mas nunca foi decidida). Se a causa foi erro inesperado: FAILED/INTERNAL_ERROR.
   * Cada tentativa conta, então nenhuma transação fica pendente para sempre.
   */
  async rescheduleOrExpire(
    repos: WageringRepositories,
    wallet: Wallet,
    tx: WagerTransaction,
    previousAttempts: number,
    cause: "reference-missing" | "processing-error",
    correlationId: string,
  ): Promise<"rescheduled" | "expired"> {
    const now = this.clock.now();
    const attempts = previousAttempts + 1;
    const exhausted = attempts >= this.policy.maxAttempts || now.getTime() - tx.createdAt.getTime() >= this.policy.ttlMs;

    if (!exhausted) {
      const delay = Math.min(this.policy.baseDelayMs * 2 ** attempts, this.policy.maxDelayMs);
      await repos.transactions.update(tx, { referenceAttempts: attempts, nextAttemptAt: new Date(now.getTime() + delay) });
      return "rescheduled";
    }

    if (cause === "processing-error") {
      tx.fail(FailureCode.InternalError);
      await repos.transactions.update(tx, { balanceAfter: wallet.balance, referenceAttempts: attempts });
      return "expired";
    }

    const reference = await this.findReference(repos, tx);
    tx.reject(reference ? FailureCode.ReferenceNotProcessed : FailureCode.ReferenceNotFound);
    await repos.transactions.update(tx, { balanceAfter: wallet.balance, referenceAttempts: attempts });
    await repos.outbox.enqueue([
      OutboxMessage.enqueue(
        WagerTransactionRejected.from(tx, wallet.balance.toJSON(), {
          eventId: this.ids.next(),
          correlationId,
          causationId: tx.id,
          occurredAt: now,
        }),
      ),
    ]);
    return "expired";
  }

  // ───────────────────────────── fase 1: decide ─────────────────────────────

  private async decide(repos: WageringRepositories, wallet: Wallet, tx: WagerTransaction, now: Date): Promise<Decision> {
    switch (tx.kind) {
      case K.Bet:
        return this.apply(wallet, tx, LedgerDirection.Debit, FailureCode.InsufficientFunds, undefined, now);

      case K.Win: {
        // referência opcional: registra o vínculo se achar uma BET válida; nunca bloqueia o WIN
        const reference = await this.findReference(repos, tx);
        const link = reference && tx.canLinkTo(reference) ? reference.id : undefined;
        return this.apply(wallet, tx, LedgerDirection.Credit, FailureCode.InsufficientFunds, link, now);
      }

      case K.Loss:
        tx.markProcessed(undefined, now);
        return { extras: { balanceAfter: wallet.balance } };

      case K.Refund:
      case K.Rollback:
        return this.decideReversal(repos, wallet, tx, now);

      case K.Opening:
        throw new Error("OPENING is settled only by CreateWallet");
    }
  }

  private async decideReversal(
    repos: WageringRepositories,
    wallet: Wallet,
    tx: WagerTransaction,
    now: Date,
  ): Promise<Decision> {
    const reference = await this.findReference(repos, tx);

    // referência ausente, ou ela própria ainda aguardando a sua: espera e reprocessa depois
    if (!reference || reference.status === S.PendingReference) {
      if (tx.status === S.PendingReference) return { extras: {}, unchanged: true };
      tx.markPendingReference();
      return {
        extras: { referenceAttempts: 0, nextAttemptAt: new Date(now.getTime() + this.policy.baseDelayMs) },
      };
    }

    let failure = tx.validateReference(reference);
    if (!failure && (await repos.transactions.findProcessedReversal(reference.id))) {
      failure = FailureCode.AlreadyReversed;
    }
    if (failure) return this.reject(wallet, tx, failure);

    const direction = tx.ledgerDirectionFor(reference);
    return this.apply(wallet, tx, direction, FailureCode.ReversalInsufficientFunds, reference.id, now);
  }

  private apply(
    wallet: Wallet,
    tx: WagerTransaction,
    direction: LedgerDirection,
    insufficientCode: FailureCode,
    referenceId: string | undefined,
    now: Date,
  ): Decision {
    if (direction === LedgerDirection.Debit && wallet.balance.isLessThan(tx.money)) {
      return this.reject(wallet, tx, insufficientCode);
    }
    const ctx = { entryId: this.ids.next(), transactionId: tx.id, at: now };
    const entry = direction === LedgerDirection.Debit ? wallet.debit(tx.money, ctx) : wallet.credit(tx.money, ctx);
    tx.markProcessed(referenceId, now);
    return { entry, extras: { balanceAfter: wallet.balance } };
  }

  private reject(wallet: Wallet, tx: WagerTransaction, code: FailureCode): Decision {
    tx.reject(code);
    return { extras: { balanceAfter: wallet.balance } };
  }

  private async findReference(repos: WageringRepositories, tx: WagerTransaction): Promise<WagerTransaction | undefined> {
    if (tx.referenceExternalTransactionId === undefined) return undefined;
    const stored = await repos.transactions.findByProviderExternal(tx.providerId, tx.referenceExternalTransactionId);
    return stored?.transaction;
  }

  // ───────────────────────────── fase 2: eventos ─────────────────────────────

  private events(
    tx: WagerTransaction,
    wallet: Wallet,
    decision: Decision,
    correlationId: string,
    now: Date,
  ): OutboxMessage[] {
    const ctx = (): EventContext => ({ eventId: this.ids.next(), correlationId, causationId: tx.id, occurredAt: now });
    const balance = decision.extras.balanceAfter?.toJSON();
    const out: OutboxMessage[] = [];

    switch (tx.status) {
      case S.Processed:
        out.push(OutboxMessage.enqueue(WagerTransactionProcessed.from(tx, balance, ctx())));
        if (decision.entry) out.push(OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, decision.entry, ctx())));
        break;
      case S.Rejected:
        out.push(OutboxMessage.enqueue(WagerTransactionRejected.from(tx, balance, ctx())));
        break;
      case S.PendingReference:
        out.push(OutboxMessage.enqueue(WagerTransactionPendingReference.from(tx, ctx())));
        break;
      default:
        break;
    }
    return out;
  }
}
