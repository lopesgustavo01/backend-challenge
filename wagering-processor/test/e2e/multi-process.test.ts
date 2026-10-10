import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { SQSClient } from "@aws-sdk/client-sqs";
import { createFifoQueue, deleteQueue, drainQueue, queueDepth, sendFifo, testSqsClient, waitFor } from "../integration/helpers/sqs";
import { uniqueId } from "../integration/helpers/app";
import { createTestDb, TestDb } from "../integration/helpers/test-db";
import { AppProcess, freePort } from "./app-process";

// PROCESSOS REAIS (bun src/main.ts) disputando o mesmo Postgres e o mesmo SQS. Nada de mock, nada de instância única:
// HTTP e SQS entram por qualquer processo, um processo é morto com SIGKILL no meio da carga e volta depois.
setDefaultTimeout(180_000);

const PROCESSES = 3;
let db: TestDb;
let sqs: SQSClient;
let input = "";
let dlq = "";
let events = "";
let procs: AppProcess[] = [];

beforeAll(async () => {
  db = await createTestDb();
  sqs = testSqsClient();
  input = await createFifoQueue(sqs, "e2e-in", 2); // visibilidade curta: mensagens de um processo morto voltam logo
  dlq = await createFifoQueue(sqs, "e2e-dlq");
  events = await createFifoQueue(sqs, "e2e-events");
  const ports: number[] = [];
  for (let i = 0; i < PROCESSES; i++) ports.push(await freePort());
  procs = ports.map((port) => new AppProcess({ port, databaseUrl: db.url, inputQueue: input, dlqQueue: dlq, eventsQueue: events }));
  await Promise.all(procs.map((p) => p.start()));
});
afterAll(async () => {
  await Promise.all(procs.map((p) => (p.alive ? p.terminate(10_000) : undefined)));
  await Promise.all([input, dlq, events].map((q) => deleteQueue(sqs, q)));
  await db.drop();
});

// ───────────────────────── helpers ─────────────────────────
const money = (amount: string) => ({ amount, currency: "BRL" });

async function createWallet(balance: string): Promise<{ id: string; playerId: string }> {
  const playerId = uniqueId("player");
  const res = await fetch(`${procs[0]!.base}/wallets`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ playerId, initialBalance: money(balance) }),
  });
  expect(res.status).toBe(201);
  return { id: ((await res.json()) as { id: string }).id, playerId };
}

const bet = (w: { id: string; playerId: string }, amount: string, externalTransactionId = uniqueId("ext")) => ({
  providerId: "provider-e2e", externalTransactionId, playerId: w.playerId, walletId: w.id, roundId: "r", gameId: "g", kind: "BET", money: money(amount),
});

/** Como um provedor real: se o processo cai/recusa, repete a MESMA requisição (mesma Idempotency-Key) em outro. */
async function postWithFailover(body: unknown, key: string, start: number): Promise<{ status: number; body: any }> {
  for (let attempt = 0; attempt < 30; attempt++) {
    const p = procs[(start + attempt) % procs.length]!;
    try {
      const res = await fetch(`${p.base}/wagering/transactions`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": key },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
      if (res.status === 503) {
        await Bun.sleep(100);
        continue;
      }
      return { status: res.status, body: await res.json() };
    } catch {
      await Bun.sleep(100); // processo morto / reiniciando
    }
  }
  throw new Error("no process accepted the request");
}

const sql = <T = any>(text: string, params: unknown[] = []) => db.sql.unsafe(text, params) as Promise<T[]>;

async function quiesced(): Promise<boolean> {
  if ((await queueDepth(sqs, input)) !== 0) return false;
  const [{ pending }] = await sql(`select count(*)::int as pending from outbox_messages where published_at is null`);
  const [{ pendingRef }] = await sql(`select count(*)::int as "pendingRef" from wager_transactions where status = 'PENDING_REFERENCE'`);
  return pending === 0 && pendingRef === 0;
}

/** Invariantes globais que TODO cenário precisa respeitar, vistos direto no banco. */
async function assertGlobalInvariants() {
  const bad = await sql(
    `select w.id, w.balance::text as stored, coalesce(sum(case l.direction when 'CREDIT' then l.amount else -l.amount end), 0)::numeric(19,2)::text as ledger
       from wallets w left join wallet_ledger_entries l on l.wallet_id = w.id
      group by w.id having w.balance <> coalesce(sum(case l.direction when 'CREDIT' then l.amount else -l.amount end), 0) or w.balance < 0`,
  );
  expect(bad).toEqual([]);
  const [{ dup }] = await sql(`select count(*)::int as dup from (select transaction_id from wallet_ledger_entries group by transaction_id having count(*) > 1) t`);
  expect(dup).toBe(0);
  expect(await drainQueue(sqs, dlq)).toHaveLength(0);
}

/** O que o outbox publicou chegou à fila de eventos: todo evento uma vez, nenhum a mais. */
const delivered = new Set<string>(); // acumulado entre cenários: a fila é esvaziada a cada verificação
async function assertEventsDelivered() {
  const rows = await sql<{ id: string }>(`select id from outbox_messages`);
  const msgs = await drainQueue(sqs, events);
  const ids = msgs.map((m) => m.MessageAttributes?.eventId?.StringValue as string);
  expect(new Set(ids).size).toBe(ids.length); // nenhuma duplicata na fila...
  for (const id of ids) {
    expect(delivered.has(id)).toBe(false); // ...nem repetida de um cenário anterior
    delivered.add(id);
  }
  expect(delivered).toEqual(new Set(rows.map((r) => r.id))); // e todo evento do outbox foi entregue
}

const balance = async (id: string) => (await sql<{ b: string }>(`select balance::text as b from wallets where id = $1`, [id]))[0]!.b;

// ───────────────────────── cenários ─────────────────────────
describe("3 processos reais", () => {
  test("HTTP + SQS concorrentes: 100,00 com dois 80,00 simultâneos em processos diferentes; fila com duplicatas; eventos publicados uma vez", async () => {
    // (a) HTTP: 10 wallets, dois BET de 80,00 ao mesmo tempo, cada um em um processo diferente
    const httpWallets = await Promise.all(Array.from({ length: 10 }, () => createWallet("100.00")));
    const httpResults = await Promise.all(
      httpWallets.flatMap((w, i) => [
        postWithFailover(bet(w, "80.00"), uniqueId("k"), i),
        postWithFailover(bet(w, "80.00"), uniqueId("k"), i + 1),
      ]),
    );
    expect(httpResults.filter((r) => r.status === 200)).toHaveLength(10);
    expect(httpResults.filter((r) => r.status === 422 && r.body.failureCode === "INSUFFICIENT_FUNDS")).toHaveLength(10);
    for (const w of httpWallets) expect(await balance(w.id)).toBe("20.00");

    // (b) SQS: 5 wallets, 15 apostas de 10,00 cada (só 10 cabem) + 5 reenvios da mesma transação
    const sqsWallets = await Promise.all(Array.from({ length: 5 }, () => createWallet("100.00")));
    for (const w of sqsWallets) {
      const bodies = Array.from({ length: 15 }, () => bet(w, "10.00"));
      for (const b of bodies) await sendFifo(sqs, input, b);
      for (const b of bodies.slice(0, 5)) await sendFifo(sqs, input, b); // reenvio
    }

    await waitFor(quiesced, 90_000);
    for (const w of sqsWallets) expect(await balance(w.id)).toBe("0.00");
    const statuses = await sql<{ status: string; n: number }>(
      `select status, count(*)::int as n from wager_transactions where wallet_id = any($1::uuid[]) and kind = 'BET' group by status`,
      [`{${sqsWallets.map((w) => w.id).join(",")}}`],
    );
    expect(Object.fromEntries(statuses.map((s) => [s.status, s.n]))).toEqual({ PROCESSED: 50, REJECTED: 25 });

    await assertGlobalInvariants();
    await assertEventsDelivered();
  });

  test("SIGKILL de um processo no meio da carga + volta: nenhum efeito perdido ou duplicado", async () => {
    const wallets = await Promise.all(Array.from({ length: 20 }, () => createWallet("1000.00")));
    const doomed = procs[1]!;

    // 200 mensagens SQS (10 de 5,00 por wallet) + 40 reenvios + 20 requisições HTTP de 3,00 (uma por wallet)
    const messages = wallets.flatMap((w) => Array.from({ length: 10 }, () => bet(w, "5.00")));
    const httpWork = wallets.map((w, i) => postWithFailover(bet(w, "3.00"), uniqueId("k"), i));

    const sender = (async () => {
      for (const [i, m] of messages.entries()) {
        await sendFifo(sqs, input, m);
        if (i % 5 === 0) await sendFifo(sqs, input, m); // reenvio da mesma transação
      }
    })();

    await Bun.sleep(400);
    await doomed.kill(); // morte abrupta, sem hook de encerramento: pode ter morrido entre commit e ACK, ou com lote do outbox alugado
    expect(doomed.alive).toBe(false);
    await Bun.sleep(1_500);
    await doomed.start(); // volta

    const http = await Promise.all(httpWork);
    await sender;
    expect(http.every((r) => r.status === 200)).toBe(true);

    await waitFor(quiesced, 120_000);

    for (const w of wallets) expect(await balance(w.id)).toBe("947.00"); // 1000 - 10*5 - 3, exatamente
    const [{ n }] = await sql(`select count(*)::int as n from wager_transactions where wallet_id = any($1::uuid[]) and kind = 'BET'`, [`{${wallets.map((w) => w.id).join(",")}}`]);
    expect(n).toBe(20 * 11);
    await assertGlobalInvariants();
    await assertEventsDelivered();
  });

  test("SIGTERM: o processo encerra sozinho (sem travar) e o sistema segue consistente com os outros", async () => {
    const w = await createWallet("100.00");
    const victim = procs[2]!;
    const sending = postWithFailover(bet(w, "10.00"), uniqueId("k"), 2);
    const outcome = await victim.terminate(20_000);
    expect(outcome.timedOut).toBe(false);
    expect(victim.alive).toBe(false);
    expect((await sending).status).toBe(200);

    // os dois restantes continuam atendendo
    const second = await postWithFailover(bet(w, "10.00"), uniqueId("k"), 2);
    expect(second.status).toBe(200);
    expect(await balance(w.id)).toBe("80.00");
    await victim.start();
    await assertGlobalInvariants();
  });

  test("observabilidade nos processos: logs JSON com correlationId e /metrics de cada instância", async () => {
    const w = await createWallet("10.00");
    const correlationId = uniqueId("corr");
    const res = await fetch(`${procs[0]!.base}/wallets/${w.id}`, { headers: { "x-correlation-id": correlationId } });
    expect(res.headers.get("x-correlation-id")).toBe(correlationId);
    await waitFor(async () => procs[0]!.stdout.some((l) => l.includes(correlationId)), 5_000);

    const lines = procs[0]!.stdout.filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));
    const entry = lines.find((l) => l.correlationId === correlationId);
    expect(entry).toMatchObject({ level: "info", message: "http request", method: "GET", route: "/wallets/:walletId", status: 200 });
    expect(typeof entry.time).toBe("string");

    for (const p of procs) {
      const text = await (await fetch(`${p.base}/metrics`)).text();
      expect(text).toContain("outbox_lag_seconds");
      expect(text).toContain("# TYPE http_requests_total counter");
    }
    // nenhum erro em nenhum processo durante os cenários saudáveis (o SIGKILL não deixa log; o resto não pode ter)
    const errorLines = procs.flatMap((p) => p.stderr).filter((l) => l.trim().startsWith("{") && JSON.parse(l).level === "error");
    expect(errorLines).toEqual([]);
  });
});
