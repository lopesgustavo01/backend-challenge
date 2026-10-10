import {
  BeforeApplicationShutdown,
  Inject,
  Injectable,
  OnApplicationBootstrap,
} from "@nestjs/common";
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import type { AppLogger, Metrics } from "@/shared/application/ports";
import { LOGGER, METRICS } from "@/shared/application/tokens";
import { SQS_CLIENT } from "./sqs.module";
import { Disposition, WagerMessageHandler } from "./wager-message-handler";

export const SQS_CONSUMER_OPTIONS = Symbol("SQS_CONSUMER_OPTIONS");

export interface SqsConsumerOptions {
  enabled: boolean;
  queueUrl: string;
  dlqUrl: string;
  /** Entregas tentadas antes de ir para a DLQ. */
  maxAttempts: number;
  waitTimeSeconds: number;
  /** Base do backoff de visibilidade (segundos): base, 2*base, 4*base... até 15 min. */
  retryBaseSeconds?: number;
  /** Pausa quando um poll volta vazio (útil quando o long polling é curto/desligado). */
  idleDelayMs?: number;
}

const MAX_VISIBILITY_SECONDS = 900;

/**
 * Consumidor da fila de entrada. Garantias:
 *  - ACK (DeleteMessage) só DEPOIS de o use case ter confirmado a transação SQL. Morrer entre o commit e o ACK
 *    causa reentrega, e o inbox (mesma transação do efeito) a transforma em no-op.
 *  - Mensagens de grupos diferentes são processadas em paralelo; dentro de um grupo, em ordem.
 *  - Erro permanente -> DLQ com o motivo; erro transitório -> volta com backoff; esgotou as tentativas -> DLQ.
 *  - stop() (SIGTERM) para de receber e espera o lote em andamento terminar.
 */
@Injectable()
export class SqsWagerConsumer
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private stopping = false;
  private loop?: Promise<void>;
  private abort?: AbortController;

  constructor(
    @Inject(SQS_CLIENT) private readonly client: SQSClient,
    @Inject(WagerMessageHandler) private readonly handler: WagerMessageHandler,
    @Inject(LOGGER) private readonly logger: AppLogger,
    @Inject(METRICS) private readonly metrics: Metrics,
    @Inject(SQS_CONSUMER_OPTIONS) private readonly options: SqsConsumerOptions,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.options.enabled) {
      this.logger.info("sqs consumer disabled");
      return;
    }
    this.start();
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.stop();
  }

  start(): void {
    if (this.loop) return;
    this.stopping = false;
    this.loop = this.run();
    this.logger.info("sqs consumer started", {
      queueUrl: this.options.queueUrl,
    });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.abort?.abort();
    await this.loop;
    this.loop = undefined;
  }

  private async run(): Promise<void> {
    while (!this.stopping) {
      try {
        const received = await this.receive();
        if (received === 0 && this.options.idleDelayMs)
          await Bun.sleep(this.options.idleDelayMs);
      } catch (error) {
        if (this.stopping) break;
        this.logger.error("sqs receive failed", { error: describe(error) });
        await Bun.sleep(1_000);
      }
    }
  }

  /** Recebe e processa um lote. Devolve quantas mensagens vieram. */
  async receive(): Promise<number> {
    this.abort = new AbortController();
    const out = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: this.options.queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: this.options.waitTimeSeconds,
        MessageSystemAttributeNames: [
          "ApproximateReceiveCount",
          "MessageGroupId",
        ],
        MessageAttributeNames: ["All"],
      }),
      { abortSignal: this.abort.signal },
    );
    const messages = out.Messages ?? [];

    // um grupo por vez (ordem), grupos em paralelo
    const groups = new Map<string, Message[]>();
    for (const m of messages) {
      const key = m.Attributes?.["MessageGroupId"] ?? m.MessageId ?? "";
      groups.set(key, [...(groups.get(key) ?? []), m]);
    }
    await Promise.all(
      [...groups.values()].map(async (batch) => {
        for (const m of batch) await this.process(m);
      }),
    );
    return messages.length;
  }

  private async process(message: Message): Promise<void> {
    const messageId = message.MessageId ?? "";
    const receiveCount = Number(
      message.Attributes?.["ApproximateReceiveCount"] ?? "1",
    );
    try {
      let disposition: Disposition;
      try {
        disposition = await this.handler.handle({
          messageId,
          body: message.Body ?? "",
          correlationId: safeId(
            message.MessageAttributes?.["correlationId"]?.StringValue,
          ),
        });
      } catch (error) {
        disposition = {
          kind: "retry",
          reason: `UNEXPECTED_ERROR: ${describe(error)}`,
        };
      }

      switch (disposition.kind) {
        case "ack":
          await this.ack(message);
          this.metrics.increment("sqs_messages_total", {
            outcome: disposition.outcome,
          });
          break;
        case "dead-letter":
          await this.deadLetter(message, disposition.reason, receiveCount);
          break;
        case "retry":
          if (receiveCount >= this.options.maxAttempts) {
            await this.deadLetter(
              message,
              `MAX_ATTEMPTS_EXCEEDED (${receiveCount}): ${disposition.reason}`,
              receiveCount,
            );
          } else {
            await this.retryLater(message, receiveCount);
            this.metrics.increment("sqs_messages_total", { outcome: "retry" });
            this.logger.warn("sqs message will be retried", {
              messageId,
              receiveCount,
              reason: disposition.reason,
            });
          }
          break;
      }
    } catch (error) {
      // falha ao falar com o SQS (ack/DLQ/visibilidade): a mensagem simplesmente reaparece. Seguro, pois é idempotente.
      this.logger.error("sqs message handling failed; it will be redelivered", {
        messageId,
        error: describe(error),
      });
      this.metrics.increment("sqs_ack_failures_total");
    }
  }

  private async ack(message: Message): Promise<void> {
    await this.client.send(
      new DeleteMessageCommand({
        QueueUrl: this.options.queueUrl,
        ReceiptHandle: message.ReceiptHandle!,
      }),
    );
  }

  /** Copia para a DLQ (com o motivo) e SÓ ENTÃO apaga da origem: se a DLQ falhar, a mensagem não se perde. */
  private async deadLetter(
    message: Message,
    reason: string,
    receiveCount: number,
  ): Promise<void> {
    const messageId = message.MessageId ?? crypto.randomUUID();
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.options.dlqUrl,
        MessageBody: message.Body ?? "",
        MessageGroupId: message.Attributes?.["MessageGroupId"] ?? "dead-letter",
        MessageDeduplicationId: messageId,
        MessageAttributes: {
          failureReason: {
            DataType: "String",
            StringValue: reason.slice(0, 1000),
          },
          originalMessageId: { DataType: "String", StringValue: messageId },
          receiveCount: {
            DataType: "Number",
            StringValue: String(receiveCount),
          },
        },
      }),
    );
    await this.ack(message);
    this.metrics.increment("sqs_messages_total", { outcome: "dead_letter" });
    this.logger.error("sqs message moved to DLQ", {
      messageId,
      receiveCount,
      reason,
    });
  }

  private async retryLater(
    message: Message,
    receiveCount: number,
  ): Promise<void> {
    const base = this.options.retryBaseSeconds ?? 5;
    const seconds = Math.min(
      base * 2 ** Math.max(0, receiveCount - 1),
      MAX_VISIBILITY_SECONDS,
    );
    await this.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: this.options.queueUrl,
        ReceiptHandle: message.ReceiptHandle!,
        VisibilityTimeout: seconds,
      }),
    );
  }
}

function safeId(value: string | undefined): string | undefined {
  return value !== undefined && /^[A-Za-z0-9_.:\-]{1,128}$/.test(value)
    ? value
    : undefined;
}

function describe(error: unknown): string {
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
}
