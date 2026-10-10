import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { MikroOrmUnitOfWork } from "@/infrastructure/persistence/postgres/mikro-orm-unit-of-work";
import { OutboxMessage } from "@/shared/messaging/outbox-message";
import { uniqueId } from "./helpers/app";
import { startServer, TestServer } from "./helpers/http-server";
import { createTestDb, TestDb } from "./helpers/test-db";

setDefaultTimeout(60_000);

let db: TestDb;
let srv: TestServer;
beforeAll(async () => {
  db = await createTestDb();
  srv = await startServer(db);
});
afterAll(async () => {
  await srv.close();
  await db.drop();
});

const j = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const res = await fetch(`${srv.base}${path}`, { method, headers: { "content-type": "application/json", ...headers }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  return { status: res.status, headers: res.headers, text, body: text.startsWith("{") ? JSON.parse(text) : undefined };
};
const metric = (text: string, name: string) =>
  text.split("\n").filter((l) => l.startsWith(name + " ") || l.startsWith(name + "{"));

describe("logs e métricas HTTP", () => {
  test("cada requisição gera UMA linha de log com correlationId, rota-padrão e status; sem corpo nem segredos", async () => {
    const playerId = uniqueId("player");
    const created = await j("POST", "/wallets", { playerId, initialBalance: { amount: "10.00", currency: "BRL" } }, { "x-correlation-id": "corr-obs-1" });
    expect(created.status).toBe(201);
    await j("GET", `/wallets/${created.body.id}`, undefined, { "x-correlation-id": "corr-obs-2" });

    const lines = srv.logger.lines.filter((l) => l.message === "http request");
    const first = lines.find((l) => l.fields?.correlationId === "corr-obs-1");
    expect(first?.fields).toMatchObject({ method: "POST", route: "/wallets", status: 201 });
    const second = lines.find((l) => l.fields?.correlationId === "corr-obs-2");
    expect(second?.fields).toMatchObject({ method: "GET", route: "/wallets/:walletId", status: 200 }); // padrão, não o id concreto
    expect(JSON.stringify(lines)).not.toContain(playerId);
    expect(typeof first?.fields?.durationMs).toBe("number");
  });

  test("/metrics: contadores por rota/status e por transação de aposta, em formato Prometheus", async () => {
    const playerId = uniqueId("p");
    const w = (await j("POST", "/wallets", { playerId, initialBalance: { amount: "50.00", currency: "BRL" } })).body;
    const bet = (amount: string) => ({ providerId: "p", externalTransactionId: uniqueId("e"), playerId, walletId: w.id, roundId: "r", gameId: "g", kind: "BET", money: { amount, currency: "BRL" } });
    await j("POST", "/wagering/transactions", bet("10.00"), { "idempotency-key": uniqueId("k") });
    await j("POST", "/wagering/transactions", bet("999.00"), { "idempotency-key": uniqueId("k") });
    await j("GET", "/nada/aqui");

    const res = await j("GET", "/metrics");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(res.text).toContain('wager_transactions_total{failureCode="INSUFFICIENT_FUNDS",kind="BET",replay="false",status="REJECTED"} 1');
    expect(res.text).toContain('wager_transactions_total{kind="BET",replay="false",status="PROCESSED"} 1');
    expect(metric(res.text, "http_requests_total").some((l) => l.includes('route="/wagering/transactions"') && l.includes('status="422"'))).toBe(true);
    expect(metric(res.text, "http_requests_total").some((l) => l.includes('route="unmatched"') && l.includes('status="404"'))).toBe(true);
  });
});

describe("lag do outbox e backlog de PENDING_REFERENCE no /metrics", () => {
  test("lag cresce com mensagem antiga pendente e zera quando é publicada", async () => {
    const uow = new MikroOrmUnitOfWork(await db.newOrm());
    await db.sql.unsafe(`delete from outbox_messages`);
    let res = await j("GET", "/metrics");
    expect(metric(res.text, "outbox_pending_messages")[0]).toBe("outbox_pending_messages 0");
    expect(metric(res.text, "outbox_lag_seconds")[0]).toBe("outbox_lag_seconds 0");

    const old = new Date(Date.now() - 90_000);
    const ids = [crypto.randomUUID(), crypto.randomUUID()];
    await uow.run((r) =>
      r.outbox.enqueue(ids.map((id) => OutboxMessage.rehydrate({ id, aggregateId: "w", eventType: "T", payload: {}, occurredAt: old, attempts: id === ids[0] ? 2 : 0, nextAttemptAt: old }))),
    );
    res = await j("GET", "/metrics");
    expect(metric(res.text, "outbox_pending_messages")[0]).toBe("outbox_pending_messages 2");
    expect(metric(res.text, "outbox_failing_messages")[0]).toBe("outbox_failing_messages 1");
    const lag = Number(metric(res.text, "outbox_lag_seconds")[0]!.split(" ")[1]);
    expect(lag).toBeGreaterThanOrEqual(90);
    expect(lag).toBeLessThan(120);

    await db.sql.unsafe(`update outbox_messages set published_at = now()`);
    res = await j("GET", "/metrics");
    expect(metric(res.text, "outbox_pending_messages")[0]).toBe("outbox_pending_messages 0");
    expect(metric(res.text, "outbox_lag_seconds")[0]).toBe("outbox_lag_seconds 0");
  });

  test("transações aguardando referência aparecem no gauge", async () => {
    const playerId = uniqueId("p");
    const w = (await j("POST", "/wallets", { playerId, initialBalance: { amount: "50.00", currency: "BRL" } })).body;
    const refund = { providerId: "p", externalTransactionId: uniqueId("e"), playerId, walletId: w.id, roundId: "r", gameId: "g", kind: "REFUND", money: { amount: "5.00", currency: "BRL" }, referenceExternalTransactionId: uniqueId("fantasma") };
    expect((await j("POST", "/wagering/transactions", refund, { "idempotency-key": uniqueId("k") })).status).toBe(202);
    const res = await j("GET", "/metrics");
    expect(Number(metric(res.text, "pending_reference_transactions")[0]!.split(" ")[1])).toBeGreaterThanOrEqual(1);
  });
});
