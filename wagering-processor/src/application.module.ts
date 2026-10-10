import { Module } from "@nestjs/common";
import { SystemClock, UuidV7Generator } from "@/infrastructure/system";
import { MikroOrmUnitOfWork } from "@/infrastructure/persistence/postgres/mikro-orm-unit-of-work";
import { AppLogger, Clock, IdGenerator, Metrics } from "@/shared/application/ports";
import { CLOCK, ID_GENERATOR, LOGGER, METRICS, UNIT_OF_WORK } from "@/shared/application/tokens";
import { GetOperationalStatsUseCase } from "@/modules/wagering/application/get-operational-stats.use-case";
import { GetWagerTransactionUseCase } from "@/modules/wagering/application/get-wager-transaction.use-case";
import { UnitOfWork } from "@/modules/wagering/application/ports";
import { ProcessWagerTransactionUseCase } from "@/modules/wagering/application/process-wager-transaction.use-case";
import { ReprocessPendingReferencesUseCase } from "@/modules/wagering/application/reprocess-pending-references.use-case";
import { WagerSettlement } from "@/modules/wagering/application/wager-settlement";
import { CreateWalletUseCase } from "@/modules/wallet/application/create-wallet.use-case";
import { GetWalletLedgerUseCase } from "@/modules/wallet/application/get-wallet-ledger.use-case";
import { GetWalletUseCase } from "@/modules/wallet/application/get-wallet.use-case";
import { ReconcileWalletUseCase } from "@/modules/wallet/application/reconcile-wallet.use-case";

/**
 * Liga as portas às implementações e monta os use cases. Os use cases não conhecem o Nest:
 * são classes puras criadas aqui por factory. LOGGER e METRICS vêm do módulo global de observabilidade.
 * Pré-requisito: MikroOrmModule.forRoot(...) no módulo raiz (fornece o MikroORM ao UnitOfWork).
 */
@Module({
  providers: [
    { provide: CLOCK, useClass: SystemClock },
    { provide: ID_GENERATOR, useClass: UuidV7Generator },
    { provide: UNIT_OF_WORK, useClass: MikroOrmUnitOfWork },
    {
      provide: WagerSettlement,
      useFactory: (clock: Clock, ids: IdGenerator) => new WagerSettlement(clock, ids),
      inject: [CLOCK, ID_GENERATOR],
    },
    {
      provide: ProcessWagerTransactionUseCase,
      useFactory: (uow: UnitOfWork, settlement: WagerSettlement, clock: Clock, ids: IdGenerator, metrics: Metrics) =>
        new ProcessWagerTransactionUseCase(uow, settlement, clock, ids, metrics),
      inject: [UNIT_OF_WORK, WagerSettlement, CLOCK, ID_GENERATOR, METRICS],
    },
    {
      provide: GetOperationalStatsUseCase,
      useFactory: (uow: UnitOfWork, clock: Clock) => new GetOperationalStatsUseCase(uow, clock),
      inject: [UNIT_OF_WORK, CLOCK],
    },
    {
      provide: ReprocessPendingReferencesUseCase,
      useFactory: (uow: UnitOfWork, settlement: WagerSettlement, clock: Clock, logger: AppLogger, metrics: Metrics) =>
        new ReprocessPendingReferencesUseCase(uow, settlement, clock, logger, metrics),
      inject: [UNIT_OF_WORK, WagerSettlement, CLOCK, LOGGER, METRICS],
    },
    {
      provide: CreateWalletUseCase,
      useFactory: (uow: UnitOfWork, clock: Clock, ids: IdGenerator) => new CreateWalletUseCase(uow, clock, ids),
      inject: [UNIT_OF_WORK, CLOCK, ID_GENERATOR],
    },
    {
      provide: GetWalletUseCase,
      useFactory: (uow: UnitOfWork) => new GetWalletUseCase(uow),
      inject: [UNIT_OF_WORK],
    },
    {
      provide: GetWalletLedgerUseCase,
      useFactory: (uow: UnitOfWork) => new GetWalletLedgerUseCase(uow),
      inject: [UNIT_OF_WORK],
    },
    {
      provide: GetWagerTransactionUseCase,
      useFactory: (uow: UnitOfWork) => new GetWagerTransactionUseCase(uow),
      inject: [UNIT_OF_WORK],
    },
    {
      provide: ReconcileWalletUseCase,
      useFactory: (uow: UnitOfWork, logger: AppLogger, metrics: Metrics) =>
        new ReconcileWalletUseCase(uow, logger, metrics),
      inject: [UNIT_OF_WORK, LOGGER, METRICS],
    },
  ],
  exports: [
    CLOCK,
    ID_GENERATOR,
    UNIT_OF_WORK,
    WagerSettlement,
    ProcessWagerTransactionUseCase,
    ReprocessPendingReferencesUseCase,
    GetOperationalStatsUseCase,
    CreateWalletUseCase,
    GetWalletUseCase,
    GetWalletLedgerUseCase,
    GetWagerTransactionUseCase,
    ReconcileWalletUseCase,
  ],
})
export class ApplicationModule {}
