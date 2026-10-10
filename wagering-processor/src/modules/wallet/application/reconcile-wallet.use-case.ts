import { MoneyProps } from "@/shared/domain/money";
import { isUuid } from "@/shared/domain/uuid";
import { AppLogger, Metrics } from "@/shared/application/ports";
import { WalletNotFoundError } from "@/modules/wagering/application/errors";
import { UnitOfWork } from "@/modules/wagering/application/ports";

export interface ReconciliationResult {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  /** stored - calculated. Diferente de zero = divergência. */
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

/**
 * Compara o saldo materializado com o saldo reconstruído pelo ledger.
 * SOMENTE LEITURA: divergência não é corrigida em silêncio. É logada, contada em métrica e sinalizada na resposta.
 */
export class ReconcileWalletUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly logger: AppLogger,
    private readonly metrics: Metrics,
  ) {}

  async execute(
    walletId: string,
    correlationId?: string,
  ): Promise<ReconciliationResult> {
    if (!isUuid(walletId)) throw new WalletNotFoundError("Wallet not found");

    // um único statement no repositório: saldo e soma leem o mesmo snapshot, sem falso positivo sob carga
    const found = await this.uow.run((repos) =>
      repos.ledger.reconcile(walletId),
    );
    if (!found) throw new WalletNotFoundError("Wallet not found");

    const difference = found.storedBalance.subtract(found.calculatedBalance);
    const consistent = difference.isZero();

    this.metrics.increment("wallet_reconciliations_total", {
      consistent: String(consistent),
    });
    if (!consistent) {
      this.metrics.increment("wallet_reconciliation_divergences_total");
      this.logger.error("wallet balance diverges from ledger", {
        walletId,
        correlationId,
        storedBalance: found.storedBalance.toJSON(),
        calculatedBalance: found.calculatedBalance.toJSON(),
        difference: difference.toJSON(),
        checkedEntries: found.checkedEntries,
      });
    }

    return {
      walletId,
      storedBalance: found.storedBalance.toJSON(),
      calculatedBalance: found.calculatedBalance.toJSON(),
      difference: difference.toJSON(),
      consistent,
      checkedEntries: found.checkedEntries,
    };
  }
}
