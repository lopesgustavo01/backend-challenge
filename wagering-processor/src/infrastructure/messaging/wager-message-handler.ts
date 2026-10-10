import { z } from "zod";
import {
  IdempotencyConflictError,
  InvalidCommandError,
  TransientProcessingError,
  WalletMismatchError,
  WalletNotFoundError,
} from "@/modules/wagering/application/errors";
import {
  ProcessWagerTransactionCommand,
  WagerTransactionResult,
} from "@/modules/wagering/application/process-wager-transaction.use-case";
import { submitTransactionSchema } from "@/modules/wagering/application/transaction-input";
import { WagerTransactionKind } from "@/modules/wagering/domain/wager-transaction";
import type { AppLogger, Metrics } from "@/shared/application/ports";

export const WAGER_CONSUMER_NAME = "wager-consumer";

/**
 * Formato da mensagem de entrada (corpo JSON): os mesmos campos do POST /wagering/transactions, mais
 * `idempotencyKey` opcional (default `${providerId}:${externalTransactionId}`).
 * O `messageId` do SQS é a chave do inbox: a MESMA mensagem entregue de novo nunca gera segundo efeito.
 */
const inboundSchema = submitTransactionSchema.extend({
  idempotencyKey: z.string().min(1).max(255).optional(),
});

export interface InboundMessage {
  messageId: string;
  body: string;
  correlationId?: string;
}

/**
 * O que fazer com a mensagem no broker:
 *  ack          efeito confirmado (ou rejeição de negócio persistida): apagar
 *  retry        falha possivelmente transitória: NÃO apagar, voltar depois (limitado por tentativas)
 *  dead-letter  nunca vai dar certo (corpo inválido, conflito de idempotência...): DLQ já
 */
export type Disposition =
  | { kind: "ack"; outcome: string }
  | { kind: "retry"; reason: string }
  | { kind: "dead-letter"; reason: string };

export interface TransactionProcessor {
  execute(
    command: ProcessWagerTransactionCommand,
  ): Promise<WagerTransactionResult>;
}

export class WagerMessageHandler {
  constructor(
    private readonly processor: TransactionProcessor,
    private readonly logger: AppLogger,
    private readonly metrics: Metrics,
  ) {}

  async handle(message: InboundMessage): Promise<Disposition> {
    const parsed = this.parse(message.body);
    if (parsed.kind !== "ok")
      return { kind: "dead-letter", reason: parsed.reason };
    const { idempotencyKey, ...dto } = parsed.value;

    try {
      const result = await this.processor.execute({
        ...dto,
        kind: dto.kind as WagerTransactionKind, // pertencimento ao enum é validado pelo use case
        referenceExternalTransactionId:
          dto.referenceExternalTransactionId ?? undefined,
        idempotencyKey:
          idempotencyKey ?? `${dto.providerId}:${dto.externalTransactionId}`,
        correlationId: message.correlationId ?? message.messageId,
        inbox: {
          consumerName: WAGER_CONSUMER_NAME,
          messageId: message.messageId,
        },
      });
      const outcome = result.idempotentReplay
        ? "duplicate"
        : result.status.toLowerCase();
      return { kind: "ack", outcome };
    } catch (error) {
      return this.classify(error);
    }
  }

  private parse(
    body: string,
  ):
    | { kind: "ok"; value: z.output<typeof inboundSchema> }
    | { kind: "invalid"; reason: string } {
    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      return {
        kind: "invalid",
        reason: "INVALID_MESSAGE: body is not valid JSON",
      };
    }
    const result = inboundSchema.safeParse(json);
    if (!result.success) {
      const detail = result.error.issues
        .map(
          (i) =>
            `${i.path.length > 0 ? i.path.join(".") : "body"}: ${i.message}`,
        )
        .join("; ");
      return { kind: "invalid", reason: `INVALID_MESSAGE: ${detail}` };
    }
    return { kind: "ok", value: result.data };
  }

  private classify(error: unknown): Disposition {
    // permanentes: reenviar a mesma mensagem nunca muda o resultado
    if (error instanceof InvalidCommandError)
      return {
        kind: "dead-letter",
        reason: `INVALID_PAYLOAD: ${error.message}`,
      };
    if (error instanceof IdempotencyConflictError)
      return {
        kind: "dead-letter",
        reason: `IDEMPOTENCY_CONFLICT: ${error.message}`,
      };
    if (error instanceof WalletMismatchError)
      return { kind: "dead-letter", reason: `${error.code}: ${error.message}` };
    // a wallet pode ainda não existir (criação em andamento): tenta de novo, com limite
    if (error instanceof WalletNotFoundError)
      return { kind: "retry", reason: "WALLET_NOT_FOUND" };
    if (error instanceof TransientProcessingError)
      return { kind: "retry", reason: "TRANSIENT_FAILURE" };

    // desconhecido: o processamento é idempotente, então tentar de novo é seguro; o limite de tentativas protege
    this.logger.error("unexpected error while processing SQS message", {
      error:
        error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error),
    });
    this.metrics.increment("sqs_unexpected_errors_total");
    return { kind: "retry", reason: "UNEXPECTED_ERROR" };
  }
}
