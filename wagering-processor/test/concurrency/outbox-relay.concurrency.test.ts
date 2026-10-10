import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { SQSClient } from "@aws-sdk/client-sqs";
import { MikroORM } from "@mikro-orm/postgresql";
import { MikroOrmUnitOfWork } from "@/infrastructure/persistence/postgres/mikro-orm-unit-of-work";
import { SqsEventPublisher } from "@/infrastructure/messaging/sqs-event-publisher";
import { OutboxRelay } from "@/modules/wagering/application/outbox-relay";
import { OutboxMessage } from "@/shared/messaging/outbox-message";
import { InMemoryMetrics } from "@/shared/observability/in-memory-metrics";
import { CapturingLogger } from "../integration/helpers/http-server";
import { createFifoQueue, deleteQueue, drainQueue, FakeClock, ObservedPublisher, testSqsClient } from "../integration/helpers/sqs";
import { createTestDb, TestDb } from "../integration/helpers/test-db";

// Três "instâncias" do publicador (ORMs e pools próprios) sobre a MESMA outbox e a MESMA fila SQS real.
setDefaultTimeout(120_000);

const INSTANCES = 3;
let db: TestDb;
let sqs: SQSClient;
let orms: MikroORM[];
let queue: string;

beforeAll(async () => {
  db = await createTestDb();
  sqs = testSqsClient();
  orms = [];
  for (let i = 0; i < INSTANCES; i++) orms.push(await db.newOrm());
});
afterAll(async () => {
  if (queue) await deleteQueue(sqs, queue);
  await db.drop();
});

async function fresh() {
  if (queue) await deleteQueue(sqs, queue);
  queue = await createFifoQueue(sqs);
  await db.sql.unsafe(`delete from outbox_messages`);
}

async function seed(n: number, aggregates: number) {
  const uow = new MikroOrmUnitOfWork(orms[0]!);
  const now = new Date();
  const ids: string[] = [];
  for (let from = 0; from < n; from += 100) {
    const batch = Array.from({ length: Math.min(100, n - from) }, (_, k) => {
      const i = from + k;
      const id = crypto.randomUUID();
      ids.push(id);
      return OutboxMessage.rehydrate({ id, aggregateId: `w-${i % aggregates}`, eventType: "TestEvent", payload: { i }, occurredAt: now, attempts: 0, nextAttemptAt: now });
    });
    await uow.run((r) => r.outbox.enqueue(batch));
  }
  return ids;
}

function relays(publisher: ObservedPublisher, clock: { now(): Date }, batchSize = 20) {
  return orms.map(
    (orm) => new OutboxRelay(new MikroOrmUnitOfWork(orm), publisher, clock, new CapturingLogger(), new InMemoryMetrics(), { batchSize, leaseMs: 30_000 }),
  );
}

describe("publicadores concorrentes sobre a mesma outbox", () => {
  test("300 mensagens, 3 instâncias em paralelo: cada mensagem é enviada EXATAMENTE uma vez (claim com aluguel)", async () => {
    await fresh();
    const ids = await seed(300, 10);
    const observed = new ObservedPublisher(new SqsEventPublisher(sqs, { queueUrl: queue }));
    const clock = { now: () => new Date() };

    await Promise.all(
      relays(observed, clock).map(async (relay) => {
        while ((await relay.runOnce()).claimed > 0);
      }),
    );

    expect(observed.sends.size).toBe(300);
    expect([...observed.sends.values()].every((n) => n === 1)).toBe(true);
    const [{ n }] = await db.sql.unsafe(`select count(*)::int as n from outbox_messages where published_at is not null`);
    expect(n).toBe(300);
    const msgs = await drainQueue(sqs, queue);
    expect(new Set(msgs.map((m) => m.MessageAttributes?.eventId?.StringValue))).toEqual(new Set(ids));
    expect(msgs).toHaveLength(300);
  });

  test("broker instável (30% de falhas) + 3 instâncias: tudo é entregue, sem perda e sem duplicata", async () => {
    await fresh();
    const ids = await seed(150, 6);
    const clock = new FakeClock();
    // falha de forma determinística em ~30% das chamadas, SEMPRE antes de enviar
    const observed = new ObservedPublisher(new SqsEventPublisher(sqs, { queueUrl: queue }), (_m, call) => call % 10 < 3);

    let passes = 0;
    for (; passes < 60; passes++) {
      await Promise.all(
        relays(observed, clock).map(async (relay) => {
          while ((await relay.runOnce()).claimed > 0);
        }),
      );
      const [{ n }] = await db.sql.unsafe(`select count(*)::int as n from outbox_messages where published_at is null`);
      if (n === 0) break;
      clock.advance(5 * 60_000); // vence qualquer backoff
    }

    const [{ n }] = await db.sql.unsafe(`select count(*)::int as n from outbox_messages where published_at is null`);
    expect(n).toBe(0);
    expect(observed.sends.size).toBe(150);
    expect([...observed.sends.values()].every((c) => c === 1)).toBe(true);
    const msgs = await drainQueue(sqs, queue);
    expect(msgs).toHaveLength(150);
    expect(new Set(msgs.map((m) => m.MessageAttributes?.eventId?.StringValue))).toEqual(new Set(ids));
    // houve falhas de verdade (o teste não é vazio)
    const [{ failed }] = await db.sql.unsafe(`select count(*)::int as failed from outbox_messages where attempts > 0`);
    expect(failed).toBeGreaterThan(0);
  });

  test("instância cai com o lote reivindicado: as outras assumem após o aluguel e entregam tudo uma vez", async () => {
    await fresh();
    const ids = await seed(40, 4);
    const clock = new FakeClock();
    const observed = new ObservedPublisher(new SqsEventPublisher(sqs, { queueUrl: queue }));

    // instância 0 reivindica 25 e "morre"
    const doomed = new MikroOrmUnitOfWork(orms[0]!);
    expect(await doomed.run((r) => r.outbox.claimDue(clock.now(), 25, 30_000))).toHaveLength(25);

    const survivors = relays(observed, clock).slice(1);
    await Promise.all(survivors.map(async (r) => { while ((await r.runOnce()).claimed > 0); }));
    expect(observed.sends.size).toBe(15); // só o que não estava alugado

    clock.advance(31_000);
    await Promise.all(survivors.map(async (r) => { while ((await r.runOnce()).claimed > 0); }));

    expect(observed.sends.size).toBe(40);
    expect([...observed.sends.values()].every((c) => c === 1)).toBe(true);
    const msgs = await drainQueue(sqs, queue);
    expect(new Set(msgs.map((m) => m.MessageAttributes?.eventId?.StringValue))).toEqual(new Set(ids));
  });
});
