import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Res } from "@nestjs/common";
import { CreateWalletUseCase } from "@/modules/wallet/application/create-wallet.use-case";
import { GetWalletLedgerUseCase } from "@/modules/wallet/application/get-wallet-ledger.use-case";
import { GetWalletUseCase } from "@/modules/wallet/application/get-wallet.use-case";
import { ReconcileWalletUseCase } from "@/modules/wallet/application/reconcile-wallet.use-case";
import { CorrelationId } from "./correlation";
import type { HttpResponse } from "./http-types";
import { createWalletSchema, optionalInteger, optionalString, parseBody } from "./schemas";
import { ledgerEntryView, walletView } from "./views";

@Controller("wallets")
export class WalletsController {
  constructor(
    @Inject(CreateWalletUseCase) private readonly createWallet: CreateWalletUseCase,
    @Inject(GetWalletUseCase) private readonly getWallet: GetWalletUseCase,
    @Inject(GetWalletLedgerUseCase) private readonly getLedger: GetWalletLedgerUseCase,
    @Inject(ReconcileWalletUseCase) private readonly reconcileWallet: ReconcileWalletUseCase,
  ) {}

  /** 201 + Location. Segunda wallet do mesmo player e moeda: 409. */
  @Post()
  async create(
    @Body() body: unknown,
    @CorrelationId() correlationId: string | undefined,
    @Res({ passthrough: true }) res: HttpResponse,
  ) {
    const dto = parseBody(createWalletSchema, body);
    const wallet = await this.createWallet.execute({ ...dto, correlationId });
    res.setHeader("Location", `/wallets/${wallet.id}`);
    return wallet;
  }

  @Get(":walletId")
  async get(@Param("walletId") walletId: string) {
    return walletView(await this.getWallet.execute(walletId));
  }

  /** Cursor opaco e estável. `limit` de 1 a 200 (padrão 50). `nextCursor` é null na última página. */
  @Get(":walletId/ledger")
  async ledger(@Param("walletId") walletId: string, @Query("cursor") cursor: unknown, @Query("limit") limit: unknown) {
    const page = await this.getLedger.execute({
      walletId,
      cursor: optionalString(cursor, "cursor"),
      limit: optionalInteger(limit, "limit"),
    });
    return { items: page.items.map(ledgerEntryView), nextCursor: page.nextCursor };
  }

  /** POST por ser uma verificação que gera efeitos de observabilidade (log/métrica); 200 mesmo com divergência. */
  @Post(":walletId/reconciliation")
  @HttpCode(200)
  async reconciliation(@Param("walletId") walletId: string, @CorrelationId() correlationId: string | undefined) {
    return this.reconcileWallet.execute(walletId, correlationId);
  }
}
