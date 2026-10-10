import { createHash } from "node:crypto";
import { DomainError } from "@/shared/domain/errors";
import { Money, MoneyProps } from "@/shared/domain/money";
import { Clock, IdGenerator } from "@/shared/application/ports";
import { EventContext } from "@/shared/messaging/integration-event";
import { OutboxMessage } from "@/shared/messaging/outbox-message";
import {
  InvalidCommandError,
  WalletAlreadyExistsError,
} from "@/modules/wagering/application/errors";
import { UnitOfWork } from "@/modules/wagering/application/ports";
import { WagerTransaction } from "@/modules/wagering/domain/wager-transaction";
import {
  WagerTransactionProcessed,
  WalletBalanceChanged,
} from "@/modules/wagering/domain/events/wager-events";
import { Wallet } from "../domain/wallet";
import {
  LedgerDirection,
  WalletLedgerEntry,
} from "../domain/wallet-ledger-entry";

export interface CreateWalletCommand {
  playerId: string;
  initialBalance: MoneyProps;
  correlationId?: string;
}

export interface CreateWalletResult {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

/** Wallet + transação OPENING + lançamento CREDIT + eventos, na MESMA transação SQL. */
export class CreateWalletUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute(command: CreateWalletCommand): Promise<CreateWalletResult> {
    if (
      typeof command.playerId !== "string" ||
      command.playerId === "" ||
      command.playerId.length > 255
    ) {
      throw new InvalidCommandError(
        "playerId must be a non-empty string up to 255 characters",
      );
    }
    let initial: Money;
    try {
      initial = Money.from(command.initialBalance);
    } catch (error) {
      throw error instanceof DomainError
        ? new InvalidCommandError(error.message)
        : error;
    }

    return this.uow.run(async (repos) => {
      const now = this.clock.now();
      const correlationId = command.correlationId ?? this.ids.next();
      const wallet = Wallet.open({
        id: this.ids.next(),
        playerId: command.playerId,
        initialBalance: initial,
        at: now,
      });

      if (!(await repos.wallets.insertIfAbsent(wallet))) {
        throw new WalletAlreadyExistsError(
          `Wallet already exists for player ${command.playerId} in ${initial.currency}`,
        );
      }

      if (initial.isPositive()) {
        const key = `opening:${wallet.id}`;
        const opening = WagerTransaction.createOpening({
          id: this.ids.next(),
          providerId: "system",
          externalTransactionId: key,
          idempotencyKey: key,
          payloadHash: createHash("sha256").update(key, "utf8").digest("hex"),
          walletId: wallet.id,
          playerId: wallet.playerId,
          roundId: "-",
          gameId: "-",
          money: initial,
          createdAt: now,
        });
        opening.markProcessed(undefined, now);

        const entry = WalletLedgerEntry.create({
          id: this.ids.next(),
          walletId: wallet.id,
          transactionId: opening.id,
          direction: LedgerDirection.Credit,
          money: initial,
          balanceBefore: Money.zero(initial.currency),
          balanceAfter: initial,
          createdAt: now,
        });

        await repos.transactions.insertIfAbsent(opening, {
          balanceAfter: wallet.balance,
        });
        await repos.ledger.append(entry);

        const ctx = (): EventContext => ({
          eventId: this.ids.next(),
          correlationId,
          causationId: opening.id,
          occurredAt: now,
        });
        await repos.outbox.enqueue([
          OutboxMessage.enqueue(
            WagerTransactionProcessed.from(
              opening,
              wallet.balance.toJSON(),
              ctx(),
            ),
          ),
          OutboxMessage.enqueue(
            WalletBalanceChanged.from(wallet, entry, ctx()),
          ),
        ]);
      }

      return {
        id: wallet.id,
        playerId: wallet.playerId,
        balance: wallet.balance.toJSON(),
        version: wallet.version,
      };
    });
  }
}
