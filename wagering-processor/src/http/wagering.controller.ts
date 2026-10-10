import { Body, Controller, Get, Headers, Inject, Param, Post, Res } from "@nestjs/common";
import { InvalidCommandError } from "@/modules/wagering/application/errors";
import { GetWagerTransactionUseCase } from "@/modules/wagering/application/get-wager-transaction.use-case";
import { ProcessWagerTransactionUseCase } from "@/modules/wagering/application/process-wager-transaction.use-case";
import { WagerTransactionKind } from "@/modules/wagering/domain/wager-transaction";
import { CorrelationId } from "./correlation";
import type { HttpResponse } from "./http-types";
import { parseBody, submitTransactionSchema } from "./schemas";
import { statusForResult, submitView, transactionView } from "./views";

// Bun não emite design:paramtypes: toda injeção usa @Inject explícito.
@Controller()
export class WageringController {
  constructor(
    @Inject(ProcessWagerTransactionUseCase) private readonly processTransaction: ProcessWagerTransactionUseCase,
    @Inject(GetWagerTransactionUseCase) private readonly transactions: GetWagerTransactionUseCase,
  ) {}

  /** Mesmo use case do consumidor SQS. O header Idempotency-Key é obrigatório e é a fonte da verdade. */
  @Post("wagering/transactions")
  async submit(
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body() body: unknown,
    @CorrelationId() correlationId: string | undefined,
    @Res({ passthrough: true }) res: HttpResponse,
  ) {
    if (idempotencyKey === undefined || idempotencyKey === "") {
      throw new InvalidCommandError("Idempotency-Key header is required");
    }
    const dto = parseBody(submitTransactionSchema, body);

    const result = await this.processTransaction.execute({
      ...dto,
      kind: dto.kind as WagerTransactionKind, // pertencimento ao enum é validado pelo use case
      referenceExternalTransactionId: dto.referenceExternalTransactionId ?? undefined,
      idempotencyKey,
      correlationId,
    });

    
    res.status(statusForResult(result.status));
    return submitView(result);
  }

  @Get("wagering/transactions/:transactionId")
  async getById(@Param("transactionId") transactionId: string) {
    return transactionView(await this.transactions.byId(transactionId));
  }

  @Get("providers/:providerId/wagering/transactions/:externalTransactionId")
  async getByProvider(
    @Param("providerId") providerId: string,
    @Param("externalTransactionId") externalTransactionId: string,
  ) {
    return transactionView(await this.transactions.byProviderExternal(providerId, externalTransactionId));
  }
}
