import { isUuid } from "@/shared/domain/uuid";
import { TransactionNotFoundError } from "./errors";
import { StoredWagerTransaction, UnitOfWork } from "./ports";

export class GetWagerTransactionUseCase {
  constructor(private readonly uow: UnitOfWork) {}

  async byId(transactionId: string): Promise<StoredWagerTransaction> {
    if (!isUuid(transactionId))
      throw new TransactionNotFoundError("Transaction not found");
    return this.uow.run(async (repos) =>
      this.found(await repos.transactions.findById(transactionId)),
    );
  }

  async byProviderExternal(
    providerId: string,
    externalTransactionId: string,
  ): Promise<StoredWagerTransaction> {
    return this.uow.run(async (repos) =>
      this.found(
        await repos.transactions.findByProviderExternal(
          providerId,
          externalTransactionId,
        ),
      ),
    );
  }

  private found(
    stored: StoredWagerTransaction | undefined,
  ): StoredWagerTransaction {
    if (!stored) throw new TransactionNotFoundError("Transaction not found");
    return stored;
  }
}
