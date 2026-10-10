import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { SQSClient } from "@aws-sdk/client-sqs";
import { MikroORM } from "@mikro-orm/postgresql";
import { MikroOrmUnitOfWork } from "@/infrastructure/persistence/postgres/mikro-orm-unit-of-work";
import { SqsEventPublisher } from "@/infrastructure/messaging/sqs-event-publisher";
import { OutboxPublisherService } from "@/infrastructure/messaging/outbox-publisher.service";
import { OutboxRelay } from "@/modules/wagering/application/outbox-relay";
import { UnitOfWork } from "@/modules/wagering/application/ports";
import { WagerTransactionKind as K } from "@/modules/wagering/domain/wager-transaction";
import { InMemoryMetrics } from "@/shared/observability/in-memory-metrics";
import { OutboxMessage } from "@/shared/messaging/outbox-message";
import { App, buildApp, command, openWallet } from "./helpers/app";
import { CapturingLogger } from "./helpers/http-server";
import { createFifoQueue, deleteQueue, drainQueue, FakeClock, ObservedPublisher, testSqsClient } from "./helpers/sqs";
import { createTestDb, TestDb } from "./helpers/test-db";

setDefaultTimeout(60_000);

let db: TestDb;
let orm: MikroORM;
let app: App;
let sqs: SQSClient;
let queue: string;

beforeAll(async () => {
  db = await createTestDb();
  orm = await db.newOrm();
  app = buildApp(orm);
  sqs = testSqsClient();
});
afterAll(async () => {
  await deleteQueue(sqs, queue);
  await db.drop();
});

// cada teste começa com fila nova e outbox vazia (publicada ou não), para as contagens serem exatas
async function fresh() {
  if (queue) await deleteQueue(sqs, queue);
  queue = await createFifoQueue(sqs);
  await db.sql.unsafe(`delete from outbox_messages`);
  return { publisher: new SqsEventPublisher(sqs, { queueUrl: queue }) };
}

function relayFor(
  publisher: ObservedPublisher | SqsEventPublisher,
  clock: FakeClock | { now(): Date } = { now: () => new Date() },
  opts: { batchSize?: number; leaseMs?: number; uow?: UnitOfWork } = {},
) {
  const logger = new CapturingLogger();
  const metrics = new InMemoryMetrics();
  const uow = opts.uow ?? new MikroOrmUnitOfWork(orm);
  const relay = new OutboxRelay(uow, publisher, clock, logger, metrics, { batchSize: opts.batchSize ?? 50, leaseMs: opts.leaseMs ?? 30_000 });
  return { relay, logger, metrics, uow };
}

async function seed(n: number, aggregates = 3, at = new Date()): Promise<string[]> {
  const uow = new MikroOrmUnitOfWork(orm);
  const messages = Array.from({ length: n }, (_, i) =>
    OutboxMessage.rehydrate({
      id: crypto.randomUUID(),
      aggregateId: `wallet-${i % aggregates}`,
      eventType: "TestEvent",
      payload: { eventId: "x", i, correlationId: `corr-${i}` },
      occurredAt: at,
      attempts: 0,
      nextAttemptAt: at,
    }),
  );
  await uow.run((r) => r.outbox.enqueue(messages));
  return messages.map((m) => m.id);
}

const row = async (id: string) =>
  (
    await db.sql.unsafe(
      `select attempts, last_error, published_at is not null as published,
              (extract(epoch from next_attempt_at) * 1000)::bigint::text as next_ms
         from outbox_messages where id = $1`,
      [id],
    )
  )[0];

describe("publicação básica", () => {
  test("publica no SQS, marca como publicada e usa group/dedup/atributos corretos", async () => {
    const { publisher } = await fresh();
    const [id] = await seed(1);
    const { relay, metrics } = relayFor(publisher);

    expect(await relay.runOnce()).toEqual({ claimed: 1, published: 1, failed: 0 });

    const msgs = await drainQueue(sqs, queue);
    expect(msgs).toHaveLength(1);
    const m = msgs[0]!;
    expect(JSON.parse(m.Body!)).toMatchObject({ i: 0 });
    expect(m.MessageAttributes?.eventType?.StringValue).toBe("TestEvent");
    expect(m.MessageAttributes?.eventId?.StringValue).toBe(id!);
    expect(m.MessageAttributes?.correlationId?.StringValue).toBe("corr-0");
    expect(m.Attributes?.MessageGroupId).toBe("wallet-0");
    expect((await row(id!)).published).toBe(true);
    expect(metrics.value("outbox_published_total", { eventType: "TestEvent" })).toBe(1);

    // nada mais a fazer
    expect(await relay.runOnce()).toEqual({ claimed: 0, published: 0, failed: 0 });
  });

  test("respeita o tamanho do lote", async () => {
    const { publisher } = await fresh();
    await seed(25);
    const { relay } = relayFor(publisher, undefined, { batchSize: 10 });
    expect((await relay.runOnce()).claimed).toBe(10);
    expect((await relay.runOnce()).claimed).toBe(10);
    expect((await relay.runOnce()).claimed).toBe(5);
    expect((await relay.runOnce()).claimed).toBe(0);
    expect(await drainQueue(sqs, queue)).toHaveLength(25);
  });

  test("mensagem publicada é imutável (trigger do schema)", async () => {
    const { publisher } = await fresh();
    const [id] = await seed(1);
    await relayFor(publisher).relay.runOnce();
    await expect(
      (async () => {
        await db.sql.unsafe(`update outbox_messages set published_at = now() + interval '1 day' where id = $1`, [id]);
      })(),
    ).rejects.toThrow("already published");
  });
});

describe("nunca publica antes do commit", () => {
  test("linha de transação aberta é invisível; depois do commit, publica; após rollback, nunca", async () => {
    const { publisher } = await fresh();
    const observed = new ObservedPublisher(publisher);
    const { relay } = relayFor(observed);

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let inserted!: () => void;
    const insertedP = new Promise<void>((r) => (inserted = r));
    const id = crypto.randomUUID();
    const tx = db.sql.begin(async (t) => {
      await t.unsafe(
        `insert into outbox_messages (id, aggregate_id, event_type, payload, occurred_at, next_attempt_at)
         values ($1, 'w', 'TestEvent', '{"a":1}', now() - interval '1 second', now() - interval '1 second')`,
        [id],
      );
      inserted();
      await gate;
    });
    await insertedP;

    expect((await relay.runOnce()).claimed).toBe(0); // existe no banco, mas não foi confirmada
    expect(observed.sends.size).toBe(0);

    release();
    await tx;
    expect((await relay.runOnce()).published).toBe(1);
    expect(observed.sends.get(id)).toBe(1);

    // rollback: nada vaza
    const ghost = crypto.randomUUID();
    await db.sql
      .begin(async (t) => {
        await t.unsafe(
          `insert into outbox_messages (id, aggregate_id, event_type, payload, occurred_at, next_attempt_at)
           values ($1, 'w', 'TestEvent', '{}', now(), now())`,
          [ghost],
        );
        throw new Error("rollback");
      })
      .catch(() => undefined);
    expect((await relay.runOnce()).claimed).toBe(0);
    expect(observed.sends.has(ghost)).toBe(false);
  });

  test("fluxo real: BET gera eventos no outbox na mesma transação e o relay os entrega ao SQS", async () => {
    const { publisher } = await fresh();
    const w = await openWallet(app, "100.00");
    await db.sql.unsafe(`delete from outbox_messages`); // ignora o evento de criação da wallet
    const cmd = command(w, K.Bet, "30.00");
    await app.process.execute(cmd);

    const pending = await db.sql.unsafe(`select id, event_type from outbox_messages where published_at is null order by seq`);
    expect(pending.length).toBeGreaterThanOrEqual(1);

    await relayFor(publisher).relay.runOnce();
    const msgs = await drainQueue(sqs, queue);
    expect(msgs.map((m) => m.MessageAttributes?.eventType?.StringValue).sort()).toEqual(
      pending.map((p: { event_type: string }) => p.event_type).sort(),
    );
    for (const m of msgs) {
      const body = JSON.parse(m.Body!);
      expect(body.aggregateId).toBe(w.id);
      expect(body.eventId).toBe(m.MessageAttributes?.eventId?.StringValue);
    }
    const balanceEvent = msgs.map((m) => JSON.parse(m.Body!)).find((b) => b.eventType === "WalletBalanceChanged");
    expect(balanceEvent?.data.balanceAfter ?? balanceEvent?.data.balance).toBeDefined();
  });
});

describe("falhas, backoff e retomada", () => {
  test("falha do broker: attempts+1, last_error, backoff exponencial; não reenvia antes da hora; recupera", async () => {
    const { publisher } = await fresh();
    const clock = new FakeClock();
    const flaky = new ObservedPublisher(publisher, (_m, call) => call < 2); // as 2 primeiras chamadas falham
    const { relay, logger, metrics } = relayFor(flaky, clock);
    const [id] = await seed(1, 1, clock.now());
    const t0 = clock.now().getTime();

    expect(await relay.runOnce()).toEqual({ claimed: 1, published: 0, failed: 1 });
    let r = await row(id!);
    expect(r.attempts).toBe(1);
    expect(r.published).toBe(false);
    expect(r.last_error).toContain("broker indisponível");
    expect(Number(r.next_ms)).toBe(t0 + 1_000);
    expect(logger.lines.some((l) => l.level === "warn" && l.fields?.eventId === id)).toBe(true);
    expect(metrics.value("outbox_publish_failures_total", { eventType: "TestEvent" })).toBe(1);

    clock.advance(500);
    expect((await relay.runOnce()).claimed).toBe(0); // ainda não venceu

    clock.advance(500);
    expect((await relay.runOnce()).failed).toBe(1);
    r = await row(id!);
    expect(r.attempts).toBe(2);
    expect(Number(r.next_ms)).toBe(t0 + 1_000 + 2_000); // 2º backoff = 2s

    clock.advance(2_000);
    expect(await relay.runOnce()).toEqual({ claimed: 1, published: 1, failed: 0 });
    r = await row(id!);
    expect(r.published).toBe(true);
    expect(r.last_error).toBeNull();
    expect(await drainQueue(sqs, queue)).toHaveLength(1);
  });

  test("instância morre após reivindicar: o aluguel protege a mensagem e depois expira", async () => {
    const { publisher } = await fresh();
    const clock = new FakeClock();
    const [id] = await seed(1, 1, clock.now());

    // "processo morto": reivindicou e nunca publicou nem marcou
    const dead = new MikroOrmUnitOfWork(orm);
    expect(await dead.run((r) => r.outbox.claimDue(clock.now(), 10, 30_000))).toHaveLength(1);

    const observed = new ObservedPublisher(publisher);
    const { relay } = relayFor(observed, clock, { leaseMs: 30_000 });
    clock.advance(10_000);
    expect((await relay.runOnce()).claimed).toBe(0); // aluguel vigente: ninguém mais mexe
    clock.advance(21_000);
    expect(await relay.runOnce()).toEqual({ claimed: 1, published: 1, failed: 0 }); // expirou: outra instância assume
    expect(observed.sends.get(id!)).toBe(1);
    expect(await drainQueue(sqs, queue)).toHaveLength(1);
  });

  test("morte DEPOIS de enviar e ANTES de marcar: reenvio é absorvido pela deduplicação do SQS FIFO", async () => {
    const { publisher } = await fresh();
    const clock = new FakeClock();
    const [id] = await seed(1, 1, clock.now());
    const observed = new ObservedPublisher(publisher);

    // a 1ª execução envia, mas a gravação de "publicada" falha (como se o processo caísse nesse ponto)
    const real = new MikroOrmUnitOfWork(orm);
    let breakMark = true;
    const uow: UnitOfWork = {
      run: (work) =>
        real.run((repos) =>
          work({
            ...repos,
            outbox: {
              ...repos.outbox,
              claimDue: (...a) => repos.outbox.claimDue(...a),
              markPublished: async (...a) => {
                if (breakMark) throw new Error("morreu antes de marcar");
                return repos.outbox.markPublished(...a);
              },
            },
          }),
        ),
    };
    const first = relayFor(observed, clock, { uow });
    await first.relay.runOnce();
    expect((await row(id!)).published).toBe(false);
    expect(first.metrics.value("outbox_mark_failures_total")).toBe(1);

    breakMark = false;
    clock.advance(31_000);
    const second = relayFor(observed, clock);
    expect(await second.relay.runOnce()).toEqual({ claimed: 1, published: 1, failed: 0 });

    expect(observed.sends.get(id!)).toBe(2); // enviada duas vezes (at-least-once)...
    expect(await drainQueue(sqs, queue)).toHaveLength(1); // ...mas o broker entrega uma só
    expect((await row(id!)).published).toBe(true);
  });
});

describe("laço de longa duração (OutboxPublisherService)", () => {
  const loopLogger = new CapturingLogger();

  async function waitFor(cond: () => Promise<boolean>, ms = 10_000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await cond()) return;
      await Bun.sleep(25);
    }
    throw new Error("timeout waiting for condition");
  }
  const pendingCount = async () => (await db.sql.unsafe(`select count(*)::int as n from outbox_messages where published_at is null`))[0].n as number;

  test("publica sozinho, e depois de stop() não reivindica mais nada", async () => {
    const { publisher } = await fresh();
    const { relay } = relayFor(publisher);
    const service = new OutboxPublisherService(relay, loopLogger, { pollIntervalMs: 20, enabled: true });
    service.onApplicationBootstrap();

    await seed(5);
    await waitFor(async () => (await pendingCount()) === 0);
    await service.stop();

    await seed(3);
    await Bun.sleep(250);
    expect(await pendingCount()).toBe(3);
    expect(await drainQueue(sqs, queue)).toHaveLength(5);
  });

  test("stop() espera o envio em andamento terminar e marcá-lo (shutdown gracioso)", async () => {
    await fresh();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const enteredP = new Promise<void>((r) => (entered = r));
    const slow = { publish: async () => { entered(); await gate; } };
    const { relay } = relayFor(slow as unknown as SqsEventPublisher);
    const service = new OutboxPublisherService(relay, loopLogger, { pollIntervalMs: 20, enabled: true });
    const [id] = await seed(1);
    service.onApplicationBootstrap();
    await enteredP;

    let stopped = false;
    const stopping = service.stop().then(() => (stopped = true));
    await Bun.sleep(100);
    expect(stopped).toBe(false); // ainda aguardando o lote em andamento
    release();
    await stopping;
    expect((await row(id!)).published).toBe(true);
  });

  test("desabilitado: não inicia o laço", async () => {
    const { publisher } = await fresh();
    const { relay } = relayFor(publisher);
    const service = new OutboxPublisherService(relay, loopLogger, { pollIntervalMs: 20, enabled: false });
    service.onApplicationBootstrap();
    await seed(2);
    await Bun.sleep(200);
    expect(await pendingCount()).toBe(2);
    await service.stop();
  });
});
