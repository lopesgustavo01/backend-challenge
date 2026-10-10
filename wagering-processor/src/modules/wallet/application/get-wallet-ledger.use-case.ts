import { isUuid } from "@/shared/domain/uuid";
import {
  InvalidCommandError,
  WalletNotFoundError,
} from "@/modules/wagering/application/errors";
import {
  LedgerPageItem,
  UnitOfWork,
} from "@/modules/wagering/application/ports";
import { decodeLedgerCursor, encodeLedgerCursor } from "./ledger-cursor";

export interface GetWalletLedgerQuery {
  walletId: string;
  cursor?: string;
  limit?: number;
}

export interface WalletLedgerPage {
  items: LedgerPageItem[];
  /** null na última página. */
  nextCursor: string | null;
}

export const DEFAULT_LEDGER_LIMIT = 50;
export const MAX_LEDGER_LIMIT = 200;

/** Lançamentos em ordem cronológica (seq crescente), paginados por cursor. */
export class GetWalletLedgerUseCase {
  constructor(private readonly uow: UnitOfWork) {}

  async execute(query: GetWalletLedgerQuery): Promise<WalletLedgerPage> {
    const limit = query.limit ?? DEFAULT_LEDGER_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LEDGER_LIMIT) {
      throw new InvalidCommandError(
        `limit must be an integer between 1 and ${MAX_LEDGER_LIMIT}`,
      );
    }
    if (!isUuid(query.walletId))
      throw new WalletNotFoundError("Wallet not found");
    const afterSeq =
      query.cursor === undefined
        ? undefined
        : decodeLedgerCursor(query.cursor, query.walletId);

    return this.uow.run(async (repos) => {
      if (!(await repos.wallets.find(query.walletId)))
        throw new WalletNotFoundError("Wallet not found");

      // pede uma a mais só para saber se existe próxima página
      const rows = await repos.ledger.listByWallet(
        query.walletId,
        afterSeq,
        limit + 1,
      );
      const items = rows.slice(0, limit);
      const last = items[items.length - 1];
      const nextCursor =
        rows.length > limit && last
          ? encodeLedgerCursor(query.walletId, last.seq)
          : null;
      return { items, nextCursor };
    });
  }
}
