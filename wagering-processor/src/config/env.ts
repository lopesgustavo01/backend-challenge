import { z } from "zod";

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1),
  AWS_REGION: z.string().default("us-east-1"),
  AWS_ENDPOINT_URL: z.string().optional(),
  SQS_QUEUE_URL: z.string().min(1),
  SQS_DLQ_URL: z.string().min(1),
  /** Fila de SAÍDA (eventos do outbox). Separada da de entrada para a aplicação não consumir os próprios eventos. */
  SQS_EVENTS_QUEUE_URL: z
    .string()
    .min(1)
    .default("http://localhost:4566/000000000000/wager-events.fifo"),
  SQS_CONSUMER_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  /** Long polling: 0-20 s. */
  SQS_WAIT_TIME_SECONDS: z.coerce.number().int().min(0).max(20).default(20),
  /** Pausa após um poll vazio. 0 em produção (long polling já espera); útil com brokers que respondem na hora. */
  SQS_IDLE_DELAY_MS: z.coerce.number().int().min(0).default(0),
  /** Entregas tentadas antes de a mensagem ir para a DLQ (o redrive do broker, 5, é só a rede de segurança). */
  SQS_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
  PENDING_REFERENCE_WORKER_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  PENDING_REFERENCE_POLL_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(10)
    .default(1000),
  PENDING_REFERENCE_BATCH_SIZE: z.coerce
    .number()
    .int()
    .min(1)
    .max(500)
    .default(20),
  OUTBOX_PUBLISHER_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().min(10).default(500),
  OUTBOX_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(50),
  /** Tempo que uma instância "é dona" de uma mensagem antes de outra poder assumir (deve exceder o envio ao SQS). */
  OUTBOX_LEASE_MS: z.coerce.number().int().min(1000).default(30_000),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

export function loadEnv(): Env {
  cached ??= schema.parse(process.env);
  return cached;
}
