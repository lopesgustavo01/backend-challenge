import { CreateQueueCommand, DeleteMessageCommand, DeleteQueueCommand, Message, ReceiveMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { EventPublisher } from "@/shared/application/ports";
import { OutboxMessage } from "@/shared/messaging/outbox-message";

/** SQS REAL (LocalStack do docker-compose; AWS_ENDPOINT_URL do ambiente). Cada teste usa filas próprias e descartáveis. */
export function testSqsClient(): SQSClient {
  return new SQSClient({
    region: process.env.AWS_REGION ?? "us-east-1",
    endpoint: process.env.AWS_ENDPOINT_URL ?? "http://localhost:4566",
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
  });
}

export async function createFifoQueue(client: SQSClient, prefix = "test-events", visibilitySeconds = 30): Promise<string> {
  const name = `${prefix}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}.fifo`;
  const out = await client.send(new CreateQueueCommand({ QueueName: name, Attributes: { FifoQueue: "true", VisibilityTimeout: String(visibilitySeconds) } }));
  return out.QueueUrl!;
}

export const deleteQueue = (client: SQSClient, url: string) => client.send(new DeleteQueueCommand({ QueueUrl: url })).catch(() => undefined);

/** Lê (e apaga) tudo que está na fila: para quando duas leituras seguidas vêm vazias. */
export async function drainQueue(client: SQSClient, url: string): Promise<Message[]> {
  const all: Message[] = [];
  let empties = 0;
  while (empties < 2) {
    const out = await client.send(
      new ReceiveMessageCommand({
        QueueUrl: url,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 0,
        MessageAttributeNames: ["All"],
        MessageSystemAttributeNames: ["All"],
      }),
    );
    const got = out.Messages ?? [];
    if (got.length === 0) {
      empties++;
      continue;
    }
    empties = 0;
    for (const m of got) {
      all.push(m);
      await client.send(new DeleteMessageCommand({ QueueUrl: url, ReceiptHandle: m.ReceiptHandle! }));
    }
  }
  return all;
}

/** Decora um publicador REAL contando os envios por eventId (e podendo falhar ANTES de enviar). */
export class ObservedPublisher implements EventPublisher {
  readonly sends = new Map<string, number>();
  constructor(
    private readonly inner: EventPublisher,
    private readonly shouldFail: (message: OutboxMessage, sendIndex: number) => boolean = () => false,
  ) {}
  private calls = 0;
  async publish(message: OutboxMessage): Promise<void> {
    if (this.shouldFail(message, this.calls++)) throw new Error("broker indisponível (injetado)");
    await this.inner.publish(message);
    this.sends.set(message.id, (this.sends.get(message.id) ?? 0) + 1);
  }
}

export class FakeClock {
  constructor(private current: Date = new Date()) {}
  now(): Date { return new Date(this.current); }
  advance(ms: number) { this.current = new Date(this.current.getTime() + ms); }
}

export async function sendFifo(client: SQSClient, queueUrl: string, body: unknown, opts: { group?: string; dedup?: string; attributes?: Record<string, string> } = {}): Promise<void> {
  const { SendMessageCommand } = await import("@aws-sdk/client-sqs");
  await client.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: typeof body === "string" ? body : JSON.stringify(body),
      MessageGroupId: opts.group ?? crypto.randomUUID(),
      MessageDeduplicationId: opts.dedup ?? crypto.randomUUID(),
      MessageAttributes: Object.fromEntries(Object.entries(opts.attributes ?? {}).map(([k, v]) => [k, { DataType: "String", StringValue: v }])),
    }),
  );
}

export async function waitFor(cond: () => Promise<boolean>, ms = 20_000, step = 25): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await Bun.sleep(step);
  }
  throw new Error(`timeout (${ms}ms) waiting for condition`);
}

/** Quantas mensagens há na fila (visíveis + em voo + atrasadas). */
export async function queueDepth(client: SQSClient, queueUrl: string): Promise<number> {
  const { GetQueueAttributesCommand } = await import("@aws-sdk/client-sqs");
  const a = (await client.send(new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ["All"] }))).Attributes ?? {};
  return Number(a["ApproximateNumberOfMessages"] ?? 0) + Number(a["ApproximateNumberOfMessagesNotVisible"] ?? 0) + Number(a["ApproximateNumberOfMessagesDelayed"] ?? 0);
}

/** Cliente SQS REAL que falha operações escolhidas (para simular morte entre o commit e o ACK, etc.). */
export function failingClient(real: SQSClient, shouldFail: (commandName: string) => boolean): SQSClient {
  return {
    send: async (command: { constructor: { name: string } }, options?: unknown) => {
      if (shouldFail(command.constructor.name)) throw new Error(`falha injetada em ${command.constructor.name}`);
      return (real.send as (c: unknown, o?: unknown) => Promise<unknown>)(command, options);
    },
  } as unknown as SQSClient;
}
