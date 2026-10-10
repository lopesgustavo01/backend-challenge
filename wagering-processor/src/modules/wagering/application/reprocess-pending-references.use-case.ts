import type { AppLogger, Clock, Metrics } from "@/shared/application/ports";
import { isTransientProcessingError } from "./errors";
import { DuePendingReference, UnitOfWork } from "./ports";
import { WagerSettlement } from "./wager-settlement";
import { WagerTransactionStatus as S } from "../domain/wager-transaction";

export type PendingReferenceOutcome =
  | "processed"
  | "rejected"
  | "rescheduled"
  | "expired"
  | "skipped"
  | "failed";

export interface PendingReferenceRunResult {
  due: number;
  outcomes: Record<PendingReferenceOutcome, number>;
}

/**
 * Worker de PENDING_REFERENCE: um REFUND/ROLLBACK que chegou antes da transação que referencia fica em espera e é
 * reavaliado com backoff até a referência aparecer (-> PROCESSED ou REJECTED por regra de negócio) ou até estourar
 * maxAttempts/TTL (-> REJECTED, REFERENCE_NOT_FOUND).
 *
 * Multi-instância sem coordenação externa: qualquer instância descobre os candidatos (leitura sem lock), mas só
 * decide DEPOIS de travar a wallet (FOR UPDATE) e reler a transação. Quem chega depois da primeira instância encontra
 * a transação já decidida ou com a próxima tentativa no futuro e pula. Resolver duas vezes é impossível: a
 * transação sai de PENDING_REFERENCE no mesmo commit que cria o lançamento, e o banco congela estados terminais.
 */
export class ReprocessPendingReferencesUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly settlement: WagerSettlement,
    private readonly clock: Clock,
    private readonly logger: AppLogger,
    private readonly metrics: Metrics,
  ) {}

  async runOnce(limit: number): Promise<PendingReferenceRunResult> {
    const due = await this.uow.run((repos) =>
      repos.transactions.findDuePendingReference(this.clock.now(), limit),
    );
    const outcomes: Record<PendingReferenceOutcome, number> = {
      processed: 0,
      rejected: 0,
      rescheduled: 0,
      expired: 0,
      skipped: 0,
      failed: 0,
    };

    for (const candidate of due) {
      const outcome = await this.reprocessSafely(candidate);
      outcomes[outcome]++;
      this.metrics.increment("pending_reference_total", { outcome });
    }
    return { due: due.length, outcomes };
  }

  private async reprocessSafely(
    candidate: DuePendingReference,
  ): Promise<PendingReferenceOutcome> {
    try {
      return await this.reprocess(candidate);
    } catch (error) {
      // lock_timeout/deadlock: não é culpa da transação; ela continua vencida e a próxima rodada tenta de novo
      if (isTransientProcessingError(error)) {
        this.logger.warn("pending reference skipped (transient)", {
          transactionId: candidate.id,
        });
        return "skipped";
      }
      return this.recordError(candidate, error);
    }
  }

  private reprocess(
    candidate: DuePendingReference,
  ): Promise<PendingReferenceOutcome> {
    return this.uow.run(async (repos): Promise<PendingReferenceOutcome> => {
      // wallet SEMPRE primeiro (mesma ordem do fluxo de entrada): sem deadlock
      const wallet = await repos.wallets.findByIdForUpdate(candidate.walletId);
      if (!wallet) return "skipped";

      const stored = await repos.transactions.findById(candidate.id);
      const now = this.clock.now();
      if (
        !stored ||
        stored.transaction.status !== S.PendingReference ||
        (stored.nextAttemptAt !== undefined &&
          stored.nextAttemptAt.getTime() > now.getTime())
      ) {
        return "skipped"; // outra instância já cuidou
      }

      const tx = stored.transaction;
      const correlationId = `pending-reference:${tx.id}`;
      const result = await this.settlement.settle(
        repos,
        wallet,
        tx,
        "update",
        correlationId,
      );
      if (!result.stillPending) {
        return result.status === S.Processed ? "processed" : "rejected";
      }
      return this.settlement.rescheduleOrExpire(
        repos,
        wallet,
        tx,
        stored.referenceAttempts,
        "reference-missing",
        correlationId,
      );
    });
  }

  /** Erro inesperado ao reprocessar: conta como tentativa, para não virar laço infinito; esgotado vira FAILED. */
  private async recordError(
    candidate: DuePendingReference,
    error: unknown,
  ): Promise<PendingReferenceOutcome> {
    this.logger.error("pending reference reprocessing failed", {
      transactionId: candidate.id,
      error:
        error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error),
    });
    try {
      return await this.uow.run(
        async (repos): Promise<PendingReferenceOutcome> => {
          const wallet = await repos.wallets.findByIdForUpdate(
            candidate.walletId,
          );
          const stored = await repos.transactions.findById(candidate.id);
          if (
            !wallet ||
            !stored ||
            stored.transaction.status !== S.PendingReference
          )
            return "skipped";
          const outcome = await this.settlement.rescheduleOrExpire(
            repos,
            wallet,
            stored.transaction,
            stored.referenceAttempts,
            "processing-error",
            `pending-reference:${candidate.id}`,
          );
          return outcome === "expired" ? "failed" : "rescheduled";
        },
      );
    } catch (secondary) {
      this.logger.error("could not record pending reference failure", {
        transactionId: candidate.id,
        error:
          secondary instanceof Error ? secondary.message : String(secondary),
      });
      return "skipped";
    }
  }
}
