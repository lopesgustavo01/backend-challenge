import { isUuid } from "@/shared/domain/uuid";
import { WalletNotFoundError } from "@/modules/wagering/application/errors";
import { UnitOfWork } from "@/modules/wagering/application/ports";
import { Wallet } from "../domain/wallet";

export class GetWalletUseCase {
  constructor(private readonly uow: UnitOfWork) {}

  async execute(walletId: string): Promise<Wallet> {
    if (!isUuid(walletId)) throw new WalletNotFoundError("Wallet not found");
    return this.uow.run(async (repos) => {
      const wallet = await repos.wallets.find(walletId);
      if (!wallet) throw new WalletNotFoundError("Wallet not found");
      return wallet;
    });
  }
}
