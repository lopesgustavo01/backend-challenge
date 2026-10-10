import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { EventPublisher } from "@/shared/application/ports";
import { OutboxMessage } from "@/shared/messaging/outbox-message";

export interface SqsEventPublisherOptions {
  queueUrl: string;
  /** Limite de uma chamada ao SQS: sem isso, um broker travado prenderia o publisher indefinidamente. */
  timeoutMs?: number;
}

/**
 * Publica no SQS FIFO. MessageGroupId = agregado (eventos da mesma wallet saem em ordem);
 * MessageDeduplicationId = eventId (reenvio dentro de 5 min não gera mensagem duplicada no broker).
 */
export class SqsEventPublisher implements EventPublisher {
  private readonly timeoutMs: number;

  constructor(
    private readonly client: SQSClient,
    private readonly options: SqsEventPublisherOptions,
  ) {
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  async publish(message: OutboxMessage): Promise<void> {
    const attributes: Record<
      string,
      { DataType: "String"; StringValue: string }
    > = {
      eventType: { DataType: "String", StringValue: message.eventType },
      eventId: { DataType: "String", StringValue: message.id },
    };
    const correlationId = message.payload["correlationId"];
    if (typeof correlationId === "string")
      attributes["correlationId"] = {
        DataType: "String",
        StringValue: correlationId,
      };

    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.options.queueUrl,
        MessageBody: JSON.stringify(message.payload),
        MessageGroupId: message.aggregateId,
        MessageDeduplicationId: message.id,
        MessageAttributes: attributes,
      }),
      { abortSignal: AbortSignal.timeout(this.timeoutMs) },
    );
  }
}
