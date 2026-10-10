import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { DeleteMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { MikroORM } from "@mikro-orm/postgresql";
import { SqsWagerConsumer, SqsConsumerOptions } from "@/infrastructure/messaging/sqs-wager-consumer";
import { WagerMessageHandler } from "@/infrastructure/messaging/wager-message-handler";
import { InMemoryMetrics } from "@/shared/observability/in-memory-metrics";
import { buildApp, expectLedgerInvariant, openWallet, uniqueId } from "./helpers/app";
import { CapturingLogger } from "./helpers/http-server";
import { createFifoQueue, deleteQueue, drainQueue, failingClient, queueDepth, sendFifo, testSqsClient, waitFor } from "./helpers/sqs";
import { createTestDb, TestDb } from "./helpers/test-db";

setDefaultTimeout(60_000);

let db: TestDb;
let orm: MikroORM;
let sqs: SQSClient;
let input = "";
let dlq = "";
let consumer: SqsWagerConsumer | undefined;

beforeAll(async () => {
  db = await createTestDb();
  orm = await db.newOrm();
  sqs = testSqsClient();
});
afterAll(async () => {
  await deleteQueue(sqs, input);
  await deleteQueue(sqs, dlq);
  await db.drop();
});
beforeEach(async () => {
  await consumer?.stop();
  consumer = undefined;
  if (input) await deleteQueue(sqs, input);
  if (dlq) await deleteQueue(sqs, dlq);
  input = await createFifoQueue(sqs, "test-in", 1); // visibilidade curta: reentregas rápidas nos testes
  dlq = await createFifoQueue(sqs, "test-dlq");
});

function startConsumer(
  overrides: Partial<SqsConsumerOptions> = {},
  deps: { client?: SQSClient; handler?: WagerMessageHandler; lockTimeoutMs?: number } = {},
) {
  const logger = new CapturingLogger();
  const metrics = new InMemoryMetrics();
  const app = buildApp(orm, { lockTimeoutMs: deps.lockTimeoutMs ?? 30_000 });
  const handler = deps.handler ?? new WagerMessageHandler(app.process, logger, metrics);
  const c = new SqsWagerConsumer(deps.client ?? sqs, handler, logger, metrics, {
    enabled: true,
    queueUrl: input,
    dlqUrl: dlq,
    maxAttempts: 5,
    waitTimeSeconds: 0,
    retryBaseSeconds: 1,
    idleDelayMs: 20,
    ...overrides,
  });
  c.start();
  consumer = c;
  return { consumer: c, logger, metrics };
}

const money = (amount: string) => ({ amount, currency: "BRL" });
function wager(w: { id: string; playerId: string }, kind: string, amount: string, extra: Record<string, unknown> = {}) {
  return {
    providerId: "provider-a", externalTransactionId: uniqueId("ext"), playerId: w.playerId, walletId: w.id,
    roundId: "r1", gameId: "g1", kind, money: money(amount), ...extra,
  };
}
const balanceOf = async (id: string) => (await db.sql.unsafe(`select balance::text as b from wallets where id = $1`, [id]))[0].b as string;
const txCount = async (walletId: string) =>
  (await db.sql.unsafe(`select count(*)::int as n from wager_transactions where wallet_id = $1 and kind <> 'OPENING'`, [walletId]))[0].n as number;
const settled = async () => (await queueDepth(sqs, input)) === 0;

describe("caminho feliz", () => {
  test("mensagem processada: saldo/ledger/outbox/inbox gravados e a mensagem apagada (ACK pós-commit)", async () => {
    const w = await openWallet(buildApp(orm), "100.00");
    const body = wager(w, "BET", "30.00");
    const { metrics } = startConsumer();
    await sendFifo(sqs, input, body, { attributes: { correlationId: "corr-1" } });

    await waitFor(async () => (await balanceOf(w.id)) === "70.00" && (await settled()));
    expect(metrics.value("sqs_messages_total", { outcome: "processed" })).toBe(1);
    expect(await expectLedgerInvariant(db.sql, w.id)).toMatchObject({ balance: "70.00" });
    const [inbox] = await db.sql.unsafe(`select count(*)::int as n, count(processed_at)::int as done from inbox_messages where consumer_name = 'wager-consumer'`);
    expect(inbox).toEqual({ n: 1, done: 1 });
    const [{ n }] = await db.sql.unsafe(`select count(*)::int as n from outbox_messages where aggregate_id = $1 and published_at is null`, [w.id]);
    expect(n).toBeGreaterThanOrEqual(1);
    expect(await drainQueue(sqs, dlq)).toHaveLength(0);
  });

  test("rejeição de negócio (saldo insuficiente) é persistida e a mensagem é apagada, sem DLQ", async () => {
    const w = await openWallet(buildApp(orm), "10.00");
    const { metrics } = startConsumer();
    const body = wager(w, "BET", "50.00");
    await sendFifo(sqs, input, body);

    await waitFor(async () => (await txCount(w.id)) === 1 && (await settled()));
    const [t] = await db.sql.unsafe(`select status, failure_code from wager_transactions where wallet_id = $1 and kind = 'BET'`, [w.id]);
    expect(t).toEqual({ status: "REJECTED", failure_code: "INSUFFICIENT_FUNDS" });
    expect(await balanceOf(w.id)).toBe("10.00");
    expect(metrics.value("sqs_messages_total", { outcome: "rejected" })).toBe(1);
    expect(await drainQueue(sqs, dlq)).toHaveLength(0);
  });
});

describe("duplicidade e morte entre o commit e o ACK", () => {
  test("a mesma transação enviada duas vezes (mensagens diferentes) debita uma vez", async () => {
    const w = await openWallet(buildApp(orm), "100.00");
    const body = wager(w, "BET", "40.00");
    const { metrics } = startConsumer();
    await sendFifo(sqs, input, body);
    await sendFifo(sqs, input, body); // outro MessageId, mesma chave de idempotência

    await waitFor(async () => (await metrics.value("sqs_messages_total", { outcome: "duplicate" })) === 1 && (await settled()));
    expect(await balanceOf(w.id)).toBe("60.00");
    expect(await txCount(w.id)).toBe(1);
    await expectLedgerInvariant(db.sql, w.id);
  });

  test("DeleteMessage falha após o commit: a mensagem volta, o inbox a absorve, e o efeito é único", async () => {
    const w = await openWallet(buildApp(orm), "100.00");
    const inboxBefore = (await db.sql.unsafe(`select count(*)::int as n from inbox_messages`))[0].n as number;
    let failures = 0;
    const flaky = failingClient(sqs, (name) => name === DeleteMessageCommand.name && failures++ < 1);
    const { metrics } = startConsumer({}, { client: flaky });
    await sendFifo(sqs, input, wager(w, "BET", "25.00"));

    await waitFor(async () => (await balanceOf(w.id)) === "75.00" && (await settled()), 30_000);
    expect(metrics.value("sqs_ack_failures_total")).toBe(1);
    expect(await balanceOf(w.id)).toBe("75.00"); // continua debitado uma vez só
    expect(await txCount(w.id)).toBe(1);
    const [{ n }] = await db.sql.unsafe(`select count(*)::int as n from inbox_messages`);
    expect(n - inboxBefore).toBe(1); // um registro de inbox por mensagem, mesmo com a reentrega
    await expectLedgerInvariant(db.sql, w.id);
  });
});

describe("mensagens que nunca darão certo vão para a DLQ, com o motivo", () => {
  const cases: Array<[string, (w: { id: string; playerId: string }) => unknown, string]> = [
    ["JSON inválido", () => "{isso não é json", "INVALID_MESSAGE"],
    ["campo obrigatório ausente", (w) => ({ ...wager(w, "BET", "1.00"), roundId: undefined }), "INVALID_MESSAGE"],
    ["valor como número (float)", (w) => ({ ...wager(w, "BET", "1.00"), money: { amount: 1.5, currency: "BRL" } }), "INVALID_MESSAGE"],
    ["valor com 3 casas", (w) => wager(w, "BET", "1.001"), "INVALID_PAYLOAD"],
    ["kind inválido", (w) => wager(w, "OPENING", "1.00"), "INVALID_PAYLOAD"],
    ["player diferente do dono da wallet", (w) => ({ ...wager(w, "BET", "1.00"), playerId: "outro" }), "PLAYER_MISMATCH"],
    ["moeda diferente da wallet", (w) => ({ ...wager(w, "BET", "1.00"), money: { amount: "1.00", currency: "USD" } }), "CURRENCY_MISMATCH"],
  ];

  test.each(cases)("%s", async (_name, make, reasonPrefix) => {
    const w = await openWallet(buildApp(orm), "100.00");
    const { metrics } = startConsumer();
    await sendFifo(sqs, input, make(w));

    await waitFor(async () => metrics.value("sqs_messages_total", { outcome: "dead_letter" }) === 1);
    await waitFor(settled);
    const dead = await drainQueue(sqs, dlq);
    expect(dead).toHaveLength(1);
    expect(dead[0]!.MessageAttributes?.failureReason?.StringValue).toStartWith(reasonPrefix);
    expect(await balanceOf(w.id)).toBe("100.00");
    expect(await txCount(w.id)).toBe(0);
  });

  test("conflito de idempotência (mesma key, valor diferente): DLQ e saldo preservado", async () => {
    const w = await openWallet(buildApp(orm), "100.00");
    const { metrics } = startConsumer();
    const first = { ...wager(w, "BET", "10.00"), idempotencyKey: "key-conflito" };
    await sendFifo(sqs, input, first);
    await waitFor(async () => (await balanceOf(w.id)) === "90.00");
    await sendFifo(sqs, input, { ...first, money: money("20.00") });

    await waitFor(async () => metrics.value("sqs_messages_total", { outcome: "dead_letter" }) === 1);
    const dead = await drainQueue(sqs, dlq);
    expect(dead[0]!.MessageAttributes?.failureReason?.StringValue).toStartWith("IDEMPOTENCY_CONFLICT");
    expect(await balanceOf(w.id)).toBe("90.00");
  });
});

describe("falhas transitórias: retry com limite", () => {
  test("wallet travada por outra conexão: a mensagem NÃO é apagada nem vai para a DLQ; processa quando destrava, uma vez", async () => {
    const w = await openWallet(buildApp(orm), "100.00");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const lockedP = new Promise<void>((r) => (locked = r));
    const holder = db.sql.begin(async (tx) => {
      await tx.unsafe(`select 1 from wallets where id = $1 for update`, [w.id]);
      locked();
      await gate;
    });
    await lockedP;

    const { metrics } = startConsumer({}, { lockTimeoutMs: 150 });
    await sendFifo(sqs, input, wager(w, "BET", "10.00"));
    await waitFor(async () => metrics.value("sqs_messages_total", { outcome: "retry" }) >= 1);
    expect(await queueDepth(sqs, input)).toBe(1); // continua na fila
    expect(await balanceOf(w.id)).toBe("100.00");

    release();
    await holder;
    await waitFor(async () => (await balanceOf(w.id)) === "90.00" && (await settled()), 30_000);
    expect(await txCount(w.id)).toBe(1);
    expect(await drainQueue(sqs, dlq)).toHaveLength(0);
    await expectLedgerInvariant(db.sql, w.id);
  });

  test("esgotadas as tentativas (wallet que não existe), vai para a DLQ com MAX_ATTEMPTS_EXCEEDED", async () => {
    const { metrics } = startConsumer({ maxAttempts: 3 });
    const ghost = { id: "0192f0e0-0000-7000-8000-00000000ffff", playerId: "p" };
    await sendFifo(sqs, input, wager(ghost, "BET", "1.00"));

    await waitFor(async () => metrics.value("sqs_messages_total", { outcome: "dead_letter" }) === 1, 30_000);
    expect(metrics.value("sqs_messages_total", { outcome: "retry" })).toBe(2); // 1ª e 2ª tentativas voltaram; a 3ª foi para a DLQ
    const dead = await drainQueue(sqs, dlq);
    expect(dead).toHaveLength(1);
    expect(dead[0]!.MessageAttributes?.failureReason?.StringValue).toContain("MAX_ATTEMPTS_EXCEEDED");
    expect(dead[0]!.MessageAttributes?.failureReason?.StringValue).toContain("WALLET_NOT_FOUND");
  });

  test("falha ao escrever na DLQ: a mensagem NÃO é apagada da origem (nada se perde)", async () => {
    const w = await openWallet(buildApp(orm), "100.00");
    const brokenDlq = failingClient(sqs, (name) => name === "SendMessageCommand");
    const { metrics } = startConsumer({}, { client: brokenDlq });
    await sendFifo(sqs, input, "{lixo");
    await waitFor(async () => metrics.value("sqs_ack_failures_total") >= 1);
    expect(await queueDepth(sqs, input)).toBe(1);
    expect(await balanceOf(w.id)).toBe("100.00");
  });
});

describe("encerramento gracioso", () => {
  test("stop() espera o processamento em andamento e a mensagem é apagada antes de retornar", async () => {
    const w = await openWallet(buildApp(orm), "100.00");
    const logger = new CapturingLogger();
    const metrics = new InMemoryMetrics();
    const real = new WagerMessageHandler(buildApp(orm).process, logger, metrics);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const enteredP = new Promise<void>((r) => (entered = r));
    const slow = { handle: async (m: Parameters<WagerMessageHandler["handle"]>[0]) => { entered(); await gate; return real.handle(m); } } as unknown as WagerMessageHandler;

    const { consumer: c } = startConsumer({}, { handler: slow });
    await sendFifo(sqs, input, wager(w, "BET", "10.00"));
    await enteredP;

    let stopped = false;
    const stopping = c.stop().then(() => (stopped = true));
    await Bun.sleep(150);
    expect(stopped).toBe(false);
    release();
    await stopping;

    expect(await balanceOf(w.id)).toBe("90.00");
    expect(await queueDepth(sqs, input)).toBe(0); // já apagada (ACK) quando stop() retornou
  });

  test("desabilitado não consome", async () => {
    const w = await openWallet(buildApp(orm), "100.00");
    const { consumer: c } = startConsumer({ enabled: false });
    await c.stop(); // o start() manual do helper é parado; agora testa o bootstrap
    c.onApplicationBootstrap();
    await sendFifo(sqs, input, wager(w, "BET", "10.00"));
    await Bun.sleep(300);
    expect(await balanceOf(w.id)).toBe("100.00");
  });
});
