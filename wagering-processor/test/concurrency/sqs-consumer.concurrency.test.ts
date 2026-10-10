import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { DeleteMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { MikroORM } from "@mikro-orm/postgresql";
import { SqsWagerConsumer } from "@/infrastructure/messaging/sqs-wager-consumer";
import { WagerMessageHandler } from "@/infrastructure/messaging/wager-message-handler";
import { InMemoryMetrics } from "@/shared/observability/in-memory-metrics";
import { buildApp, expectLedgerInvariant, openWallet, uniqueId } from "../integration/helpers/app";
import { CapturingLogger } from "../integration/helpers/http-server";
import { createFifoQueue, deleteQueue, drainQueue, failingClient, queueDepth, sendFifo, testSqsClient, waitFor } from "../integration/helpers/sqs";
import { createTestDb, TestDb } from "../integration/helpers/test-db";

// Três consumidores (ORM e pool próprios) competindo pela MESMA fila SQS real e pelo MESMO Postgres.
setDefaultTimeout(120_000);

let db: TestDb;
let sqs: SQSClient;
let orms: MikroORM[];
let input = "";
let dlq = "";
const running: SqsWagerConsumer[] = [];

beforeAll(async () => {
  db = await createTestDb();
  sqs = testSqsClient();
  orms = [await db.newOrm(), await db.newOrm(), await db.newOrm()];
});
afterAll(async () => {
  await Promise.all(running.map((c) => c.stop()));
  await deleteQueue(sqs, input);
  await deleteQueue(sqs, dlq);
  await db.drop();
});

async function freshQueues() {
  await Promise.all(running.splice(0).map((c) => c.stop()));
  if (input) await deleteQueue(sqs, input);
  if (dlq) await deleteQueue(sqs, dlq);
  input = await createFifoQueue(sqs, "conc-in", 1);
  dlq = await createFifoQueue(sqs, "conc-dlq");
}

function startAll(clientFor: (i: number) => SQSClient = () => sqs, which = [0, 1, 2]) {
  const metrics = new InMemoryMetrics();
  for (const i of which) {
    const logger = new CapturingLogger();
    const app = buildApp(orms[i]!, { lockTimeoutMs: 30_000 });
    const c = new SqsWagerConsumer(clientFor(i), new WagerMessageHandler(app.process, logger, metrics), logger, metrics, {
      enabled: true, queueUrl: input, dlqUrl: dlq, maxAttempts: 5, waitTimeSeconds: 0, retryBaseSeconds: 1, idleDelayMs: 10,
    });
    c.start();
    running.push(c);
  }
  return metrics;
}

const money = (a: string) => ({ amount: a, currency: "BRL" });
const wager = (w: { id: string; playerId: string }, amount: string, extra: Record<string, unknown> = {}) => ({
  providerId: "provider-a", externalTransactionId: uniqueId("ext"), playerId: w.playerId, walletId: w.id,
  roundId: "r1", gameId: "g1", kind: "BET", money: money(amount), ...extra,
});
const balanceOf = async (id: string) => (await db.sql.unsafe(`select balance::text as b from wallets where id = $1`, [id]))[0].b as string;
const idle = async () => (await queueDepth(sqs, input)) === 0;

describe("consumidores concorrentes", () => {
  test("saldo 100.00 e 30 apostas de 10.00 em grupos diferentes (paralelismo real): 10 processadas, 20 rejeitadas, saldo 0.00", async () => {
    await freshQueues();
    const { orm } = { orm: orms[0]! };
    const w = await openWallet(buildApp(orm), "100.00");
    for (let i = 0; i < 30; i++) await sendFifo(sqs, input, wager(w, "10.00")); // cada mensagem = um grupo
    const metrics = startAll();

    await waitFor(async () => (await db.sql.unsafe(`select count(*)::int as n from wager_transactions where wallet_id = $1 and kind <> 'OPENING'`, [w.id]))[0].n === 30 && (await idle()), 60_000);
    expect(await balanceOf(w.id)).toBe("0.00");
    const rows = await db.sql.unsafe(`select status, count(*)::int as n from wager_transactions where wallet_id = $1 and kind <> 'OPENING' group by status`, [w.id]);
    expect(Object.fromEntries(rows.map((r: { status: string; n: number }) => [r.status, r.n]))).toEqual({ PROCESSED: 10, REJECTED: 20 });
    expect(metrics.value("sqs_messages_total", { outcome: "dead_letter" })).toBe(0);
    expect(await drainQueue(sqs, dlq)).toHaveLength(0);
    await expectLedgerInvariant(db.sql, w.id);
  });

  test("120 apostas em 6 wallets + 20 reenvios da mesma transação: nenhuma duplicidade, saldos exatos", async () => {
    await freshQueues();
    const wallets = [];
    for (let i = 0; i < 6; i++) wallets.push(await openWallet(buildApp(orms[0]!), "1000.00"));
    const sent: Record<string, number> = Object.fromEntries(wallets.map((w) => [w.id, 0]));
    const bodies = [];
    for (let i = 0; i < 120; i++) {
      const w = wallets[i % 6]!;
      bodies.push(wager(w, "5.00"));
      sent[w.id]! += 5;
    }
    for (const b of bodies) await sendFifo(sqs, input, b);
    for (let i = 0; i < 20; i++) await sendFifo(sqs, input, bodies[i * 6]!); // reenvio: mesma chave de idempotência
    const metrics = startAll();

    await waitFor(async () => (await idle()) && metrics.value("sqs_messages_total", { outcome: "processed" }) + metrics.value("sqs_messages_total", { outcome: "duplicate" }) === 140, 90_000);
    for (const w of wallets) {
      const expected = (1000 - sent[w.id]!).toFixed(2);
      expect(await balanceOf(w.id)).toBe(expected);
      await expectLedgerInvariant(db.sql, w.id);
    }
    const [{ n }] = await db.sql.unsafe(`select count(*)::int as n from wager_transactions where kind = 'BET' and wallet_id = any($1::uuid[])`, [`{${wallets.map((x) => x.id).join(",")}}`]);
    expect(n).toBe(120);
    expect(metrics.value("sqs_messages_total", { outcome: "duplicate" })).toBe(20);
  });

  test("consumidor que processa mas MORRE antes do ACK: outro assume, as mensagens reaparecem e nada é aplicado duas vezes", async () => {
    await freshQueues();
    const w = await openWallet(buildApp(orms[0]!), "500.00");
    for (let i = 0; i < 25; i++) await sendFifo(sqs, input, wager(w, "10.00"));

    // consumidor A: o commit acontece, mas o ACK nunca chega (como um processo que cai logo após o commit)
    const dying = failingClient(sqs, (name) => name === DeleteMessageCommand.name);
    startAll(() => dying, [0]);
    await waitFor(async () => (await db.sql.unsafe(`select count(*)::int as n from wager_transactions where wallet_id = $1 and kind = 'BET'`, [w.id]))[0].n === 25, 60_000);
    await Promise.all(running.splice(0).map((c) => c.stop()));
    expect(await balanceOf(w.id)).toBe("250.00");
    expect(await idle()).toBe(false); // todas ainda na fila

    // consumidores B e C assumem
    const metrics = startAll(() => sqs, [1, 2]);
    await waitFor(idle, 60_000);
    expect(metrics.value("sqs_messages_total", { outcome: "duplicate" })).toBe(25);
    expect(await balanceOf(w.id)).toBe("250.00"); // continua debitado uma vez por mensagem
    const [{ n }] = await db.sql.unsafe(`select count(*)::int as n from wager_transactions where wallet_id = $1 and kind = 'BET'`, [w.id]);
    expect(n).toBe(25);
    await expectLedgerInvariant(db.sql, w.id);
  });
});
