import { DomainError } from "@/shared/domain/errors";
import { Money, MoneyProps } from "@/shared/domain/money";
import { Clock, IdGenerator, Metrics } from "@/shared/application/ports";
import { InboxMessage } from "@/shared/messaging/inbox-message";
import { FailureCode } from "../domain/failure-code";
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../domain/wager-transaction";
import {
  IdempotencyConflictError,
  InvalidCommandError,
  TransientProcessingError,
  WalletMismatchError,
  WalletNotFoundError,
} from "./errors";
import { computePayloadHash } from "./payload-hash";
import {
  StoredWagerTransaction,
  UnitOfWork,
  WageringRepositories,
} from "./ports";
import { WagerSettlement } from "./wager-settlement";

export interface ProcessWagerTransactionCommand {
  providerId: string;
  externalTransactionId: string;
  /** Fonte da verdade da idempotência. Default recomendado: `${providerId}:${externalTransactionId}`. */
  idempotencyKey: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
  correlationId?: string;
  /** Presente quando a entrada é SQS: deduplicação persistente na MESMA transação SQL. */
  inbox?: { consumerName: string; messageId: string };
}

export interface WagerTransactionResult {
  transactionId: string;
  status: WagerTransactionStatus;
  failureCode?: FailureCode;
  /** Saldo observado quando a transação foi decidida. Ausente em PENDING_REFERENCE. */
  balance?: MoneyProps;
  idempotentReplay: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ID_LENGTH = 255;
const EXTERNAL_KINDS: ReadonlySet<string> = new Set([
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
]);

/**
 * Caso de uso ÚNICO, chamado pela API HTTP e pelo consumidor SQS.
 *
 * Tudo acontece em UMA transação SQL, nesta ordem (a ordem evita deadlock e garante a idempotência):
 *   1. inbox (se SQS)            2. lock da wallet (FOR UPDATE)     3. replay / conflito de idempotência
 *   4. decide + claim da key     5. saldo + ledger                  6. outbox       7. commit
 *
 * A wallet é travada ANTES de qualquer INSERT que a referencie: a FK compartilha um lock FOR KEY SHARE
 * na linha, e duas transações com KEY SHARE tentando FOR UPDATE se travam em deadlock.
 */
export class ProcessWagerTransactionUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly settlement: WagerSettlement,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly metrics?: Metrics,
  ) {}

  async execute(
    command: ProcessWagerTransactionCommand,
  ): Promise<WagerTransactionResult> {
    const result = await this.process(command);
    // contado DEPOIS do commit: a métrica descreve o que de fato foi confirmado
    this.metrics?.increment("wager_transactions_total", {
      kind: command.kind,
      status: result.status,
      replay: String(result.idempotentReplay),
      ...(result.failureCode ? { failureCode: result.failureCode } : {}),
    });
    return result;
  }

  private async process(
    command: ProcessWagerTransactionCommand,
  ): Promise<WagerTransactionResult> {
    const { money, payloadHash } = this.prepare(command);

    return this.uow.run(async (repos) => {
      const correlationId = command.correlationId ?? this.ids.next();

      if (command.inbox) {
        const message = InboxMessage.receive({
          ...command.inbox,
          payloadHash,
          receivedAt: this.clock.now(),
        });
        if (!(await repos.inbox.tryReceive(message))) {
          // mensagem já processada: o efeito foi confirmado na mesma transação em que o inbox foi gravado
          return this.replayByKey(repos, command.idempotencyKey, payloadHash);
        }
      }

      const wallet = await repos.wallets.findByIdForUpdate(command.walletId);
      if (!wallet)
        throw new WalletNotFoundError(`Wallet ${command.walletId} not found`);

      const existing = await repos.transactions.findByIdempotencyKey(
        command.idempotencyKey,
      );
      if (existing) return this.replay(existing, payloadHash);

      const sameExternal = await repos.transactions.findByProviderExternal(
        command.providerId,
        command.externalTransactionId,
      );
      if (sameExternal) {
        throw new IdempotencyConflictError(
          `Transaction ${command.externalTransactionId} of provider ${command.providerId} was already submitted with another idempotency key`,
        );
      }

      if (wallet.playerId !== command.playerId) {
        throw new WalletMismatchError(
          "PLAYER_MISMATCH",
          "playerId does not match the wallet owner",
        );
      }
      if (wallet.currency !== money.currency) {
        throw new WalletMismatchError(
          "CURRENCY_MISMATCH",
          `Wallet currency is ${wallet.currency}, got ${money.currency}`,
        );
      }

      const transaction = this.createTransaction(command, money, payloadHash);
      const result = await this.settlement.settle(
        repos,
        wallet,
        transaction,
        "insert",
        correlationId,
      );

      if (result.raced) {
        // outra requisição com a mesma key confirmou antes: o resultado dela é o nosso
        return this.replayByKey(repos, command.idempotencyKey, payloadHash);
      }

      if (command.inbox) {
        const processed = InboxMessage.receive({
          ...command.inbox,
          payloadHash,
          receivedAt: this.clock.now(),
        });
        processed.markProcessed(this.clock.now());
        await repos.inbox.markProcessed(processed);
      }

      return {
        transactionId: transaction.id,
        status: transaction.status,
        failureCode: transaction.failureCode,
        balance: result.balanceAfter?.toJSON(),
        idempotentReplay: false,
      };
    });
  }

  // ─────────────────────────────── helpers ───────────────────────────────

  private prepare(command: ProcessWagerTransactionCommand): {
    money: Money;
    payloadHash: string;
  } {
    const required: Array<[string, unknown]> = [
      ["providerId", command.providerId],
      ["externalTransactionId", command.externalTransactionId],
      ["idempotencyKey", command.idempotencyKey],
      ["playerId", command.playerId],
      ["roundId", command.roundId],
      ["gameId", command.gameId],
    ];
    for (const [name, value] of required) {
      if (
        typeof value !== "string" ||
        value === "" ||
        value.length > MAX_ID_LENGTH
      ) {
        throw new InvalidCommandError(
          `${name} must be a non-empty string up to ${MAX_ID_LENGTH} characters`,
        );
      }
    }
    if (command.referenceExternalTransactionId !== undefined) {
      const ref = command.referenceExternalTransactionId;
      if (typeof ref !== "string" || ref === "" || ref.length > MAX_ID_LENGTH) {
        throw new InvalidCommandError(
          "referenceExternalTransactionId must be a non-empty string",
        );
      }
    }
    if (typeof command.walletId !== "string" || !UUID.test(command.walletId)) {
      throw new InvalidCommandError("walletId must be a UUID");
    }
    if (!EXTERNAL_KINDS.has(command.kind)) {
      throw new InvalidCommandError(
        `kind must be one of ${[...EXTERNAL_KINDS].join(", ")}`,
      );
    }

    try {
      const money = Money.from(command.money);
      return {
        money,
        payloadHash: computePayloadHash({ ...command, money: command.money }),
      };
    } catch (error) {
      throw this.asInvalidCommand(error);
    }
  }

  private createTransaction(
    command: ProcessWagerTransactionCommand,
    money: Money,
    payloadHash: string,
  ): WagerTransaction {
    try {
      return WagerTransaction.create({
        id: this.ids.next(),
        providerId: command.providerId,
        externalTransactionId: command.externalTransactionId,
        idempotencyKey: command.idempotencyKey,
        payloadHash,
        walletId: command.walletId,
        playerId: command.playerId,
        roundId: command.roundId,
        gameId: command.gameId,
        kind: command.kind,
        money,
        referenceExternalTransactionId: command.referenceExternalTransactionId,
        createdAt: this.clock.now(),
      });
    } catch (error) {
      throw this.asInvalidCommand(error);
    }
  }

  private asInvalidCommand(error: unknown): Error {
    return error instanceof DomainError
      ? new InvalidCommandError(error.message)
      : (error as Error);
  }

  private replay(
    stored: StoredWagerTransaction,
    payloadHash: string,
  ): WagerTransactionResult {
    const { transaction } = stored;
    if (!transaction.matchesPayload(payloadHash)) {
      throw new IdempotencyConflictError(
        `Idempotency key ${transaction.idempotencyKey} was already used with a different payload`,
      );
    }
    return {
      transactionId: transaction.id,
      status: transaction.status,
      failureCode: transaction.failureCode,
      balance: stored.balanceAfter?.toJSON(),
      idempotentReplay: true,
    };
  }

  private async replayByKey(
    repos: WageringRepositories,
    key: string,
    payloadHash: string,
  ): Promise<WagerTransactionResult> {
    const stored = await repos.transactions.findByIdempotencyKey(key);
    if (!stored) {
      // não deveria ocorrer: a transação existe se a corrida foi perdida ou o inbox já estava gravado
      throw new TransientProcessingError(
        `Transaction for idempotency key ${key} is not visible yet`,
      );
    }
    return this.replay(stored, payloadHash);
  }
}
