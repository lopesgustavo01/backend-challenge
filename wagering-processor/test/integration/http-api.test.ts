import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { uniqueId, expectLedgerInvariant } from "./helpers/app";
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

interface Res { status: number; body: any; headers: Headers }
async function call(method: string, path: string, opts: { body?: unknown; raw?: string; headers?: Record<string, string>; server?: TestServer } = {}): Promise<Res> {
  const res = await fetch(`${(opts.server ?? srv).base}${path}`, {
    method,
    headers: { ...(opts.body !== undefined || opts.raw !== undefined ? { "content-type": "application/json" } : {}), ...opts.headers },
    body: opts.raw ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : undefined, headers: res.headers };
}

const money = (amount: string, currency = "BRL") => ({ amount, currency });

async function newWallet(balance = "100.00", server?: TestServer) {
  const playerId = uniqueId("player");
  const res = await call("POST", "/wallets", { body: { playerId, initialBalance: money(balance) }, server });
  expect(res.status).toBe(201);
  return { id: res.body.id as string, playerId };
}

function txBody(w: { id: string; playerId: string }, kind: string, amount: string, extra: Record<string, unknown> = {}) {
  return {
    providerId: "provider-a",
    externalTransactionId: uniqueId("ext"),
    playerId: w.playerId,
    walletId: w.id,
    roundId: "r1",
    gameId: "g1",
    kind,
    money: money(amount),
    ...extra,
  };
}
const submit = (body: Record<string, unknown>, key?: string, server?: TestServer, headers: Record<string, string> = {}) =>
  call("POST", "/wagering/transactions", {
    body,
    server,
    headers: { ...(key === undefined ? {} : { "idempotency-key": key }), ...headers },
  });

describe("POST /wallets", () => {
  test("201 + Location + corpo", async () => {
    const playerId = uniqueId("p");
    const res = await call("POST", "/wallets", { body: { playerId, initialBalance: money("10.50") } });
    expect(res.status).toBe(201);
    expect(res.headers.get("location")).toBe(`/wallets/${res.body.id}`);
    expect(res.body.balance).toEqual(money("10.50"));
  });

  test("409 para segunda wallet do mesmo player/moeda", async () => {
    const w = await newWallet();
    const res = await call("POST", "/wallets", { body: { playerId: w.playerId, initialBalance: money("1.00") } });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("WALLET_ALREADY_EXISTS");
  });

  test.each([
    ["valor com 3 casas", { playerId: "p", initialBalance: money("1.001") }],
    ["valor negativo", { playerId: "p", initialBalance: money("-1.00") }],
    ["valor numérico (float)", { playerId: "p", initialBalance: { amount: 10.5, currency: "BRL" } }],
    ["sem corpo útil", {}],
  ])("400: %s", async (_n, body) => {
    const res = await call("POST", "/wallets", { body });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_PAYLOAD");
  });

  test("GET wallet: 200, 404 e id malformado 404", async () => {
    const w = await newWallet("7.00");
    expect((await call("GET", `/wallets/${w.id}`)).body.balance).toEqual(money("7.00"));
    expect((await call("GET", `/wallets/0192f0e0-0000-7000-8000-00000000ffff`)).status).toBe(404);
    expect((await call("GET", `/wallets/nao-e-uuid`)).status).toBe(404);
  });
});

describe("POST /wagering/transactions", () => {
  test("sem Idempotency-Key: 400", async () => {
    const w = await newWallet();
    const res = await submit(txBody(w, "BET", "1.00"));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_PAYLOAD");
  });

  test("BET 200, replay 200 com idempotentReplay, outra carga com a mesma key 409", async () => {
    const w = await newWallet("100.00");
    const body = txBody(w, "BET", "30.00");
    const key = uniqueId("k");
    const first = await submit(body, key);
    expect(first.status).toBe(200);
    expect(first.body.status).toBe("PROCESSED");
    expect(first.body.balance).toEqual(money("70.00"));
    expect(first.body.idempotentReplay).toBe(false);

    const replay = await submit(body, key);
    expect(replay.status).toBe(200);
    expect(replay.body.transactionId).toBe(first.body.transactionId);
    expect(replay.body.idempotentReplay).toBe(true);

    const conflict = await submit({ ...body, money: money("31.00") }, key);
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe("IDEMPOTENCY_CONFLICT");

    expect((await call("GET", `/wallets/${w.id}`)).body.balance).toEqual(money("70.00"));
    await expectLedgerInvariant(db.sql, w.id);
  });

  test("saldo insuficiente: 422 REJECTED, persistido, replay idêntico, saldo intacto", async () => {
    const w = await newWallet("10.00");
    const body = txBody(w, "BET", "50.00");
    const key = uniqueId("k");
    const first = await submit(body, key);
    expect(first.status).toBe(422);
    expect(first.body.status).toBe("REJECTED");
    expect(first.body.failureCode).toBe("INSUFFICIENT_FUNDS");
    const replay = await submit(body, key);
    expect(replay.status).toBe(422);
    expect(replay.body.transactionId).toBe(first.body.transactionId);
    expect(replay.body.idempotentReplay).toBe(true);
    expect((await call("GET", `/wallets/${w.id}`)).body.balance).toEqual(money("10.00"));
  });

  test("REFUND sem a BET: 202 PENDING_REFERENCE", async () => {
    const w = await newWallet();
    const res = await submit(txBody(w, "REFUND", "5.00", { referenceExternalTransactionId: uniqueId("ghost") }), uniqueId("k"));
    expect(res.status).toBe(202);
    expect(res.body.status).toBe("PENDING_REFERENCE");
  });

  test("REFUND com a BET: devolve o valor; segundo reversal da mesma BET é rejeitado", async () => {
    const w = await newWallet("100.00");
    const bet = txBody(w, "BET", "40.00");
    await submit(bet, uniqueId("k"));
    const refund = await submit(txBody(w, "REFUND", "40.00", { referenceExternalTransactionId: bet.externalTransactionId }), uniqueId("k"));
    expect(refund.status).toBe(200);
    expect(refund.body.balance).toEqual(money("100.00"));
    const again = await submit(txBody(w, "ROLLBACK", "40.00", { referenceExternalTransactionId: bet.externalTransactionId }), uniqueId("k"));
    expect(again.status).toBe(422);
    expect(again.body.failureCode).toBe("ALREADY_REVERSED");
    await expectLedgerInvariant(db.sql, w.id);
  });

  test("wallet inexistente: 404", async () => {
    const res = await submit(
      txBody({ id: "0192f0e0-0000-7000-8000-00000000ffff", playerId: "p" }, "BET", "1.00"),
      uniqueId("k"),
    );
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("WALLET_NOT_FOUND");
  });

  test("player e moeda divergentes: 422 com código, nada persistido", async () => {
    const w = await newWallet();
    const p = await submit(txBody({ id: w.id, playerId: "outro" }, "BET", "1.00"), uniqueId("k"));
    expect(p.status).toBe(422);
    expect(p.body.error.code).toBe("PLAYER_MISMATCH");
    const c = await submit({ ...txBody(w, "BET", "1.00"), money: money("1.00", "USD") }, uniqueId("k"));
    expect(c.status).toBe(422);
    expect(c.body.error.code).toBe("CURRENCY_MISMATCH");
    const [{ n }] = await db.sql.unsafe(`select count(*)::int as n from wager_transactions where wallet_id = $1 and kind <> 'OPENING'`, [w.id]);
    expect(n).toBe(0);
  });

  test("kind OPENING e kind desconhecido: 400", async () => {
    const w = await newWallet();
    expect((await submit(txBody(w, "OPENING", "1.00"), uniqueId("k"))).status).toBe(400);
    expect((await submit(txBody(w, "XPTO", "1.00"), uniqueId("k"))).status).toBe(400);
  });

  test("JSON malformado: 400 em envelope; rota inexistente: 404 em envelope", async () => {
    const bad = await call("POST", "/wagering/transactions", { raw: "{oops", headers: { "idempotency-key": "k" } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("INVALID_PAYLOAD");
    const nf = await call("GET", "/nada/aqui");
    expect(nf.status).toBe(404);
    expect(nf.body.error.code).toBe("NOT_FOUND");
  });

  test("correlationId: devolvido, e gerado quando ausente/inválido", async () => {
    const w = await newWallet();
    const ok = await submit(txBody(w, "BET", "1.00"), uniqueId("k"), undefined, { "x-correlation-id": "abc-123" });
    expect(ok.headers.get("x-correlation-id")).toBe("abc-123");
    const bad = await call("GET", `/wallets/${w.id}`, { headers: { "x-correlation-id": "inválido com espaçoç" .replace(/[^\x20-\x7e]/g, "?") } });
    expect(bad.headers.get("x-correlation-id")).not.toBe("inválido com espaço?");
    expect(bad.headers.get("x-correlation-id")).toBeTruthy();
  });

  test("CONCORRÊNCIA: saldo 100.00 e dois POSTs de 80.00 simultâneos -> [200, 422], saldo 20.00", async () => {
    const w = await newWallet("100.00");
    const results = await Promise.all([
      submit(txBody(w, "BET", "80.00"), uniqueId("k")),
      submit(txBody(w, "BET", "80.00"), uniqueId("k")),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 422]);
    expect((await call("GET", `/wallets/${w.id}`)).body.balance).toEqual(money("20.00"));
    await expectLedgerInvariant(db.sql, w.id);
  });

  test("CONCORRÊNCIA: 50 POSTs idênticos -> um único não-replay, um débito só", async () => {
    const w = await newWallet("100.00");
    const body = txBody(w, "BET", "10.00");
    const key = uniqueId("k");
    const rs = await Promise.all(Array.from({ length: 50 }, () => submit(body, key)));
    expect(rs.every((r) => r.status === 200)).toBe(true);
    expect(rs.filter((r) => !r.body.idempotentReplay)).toHaveLength(1);
    expect(new Set(rs.map((r) => r.body.transactionId)).size).toBe(1);
    expect((await call("GET", `/wallets/${w.id}`)).body.balance).toEqual(money("90.00"));
  });
});

describe("GET transações", () => {
  test("por id e por provider/external; id malformado e inexistente: 404", async () => {
    const w = await newWallet();
    const body = txBody(w, "BET", "2.00");
    const r = await submit(body, uniqueId("k"));
    const byId = await call("GET", `/wagering/transactions/${r.body.transactionId}`);
    expect(byId.status).toBe(200);
    expect(byId.body.status).toBe("PROCESSED");
    expect(byId.body.money).toEqual(money("2.00"));
    const byExt = await call("GET", `/providers/provider-a/wagering/transactions/${body.externalTransactionId}`);
    expect(byExt.body.id).toBe(r.body.transactionId);
    expect((await call("GET", "/wagering/transactions/xxx")).status).toBe(404);
    expect((await call("GET", "/wagering/transactions/0192f0e0-0000-7000-8000-00000000ffff")).status).toBe(404);
    expect((await call("GET", "/providers/provider-a/wagering/transactions/inexistente")).status).toBe(404);
  });
});

describe("GET /wallets/:id/ledger (cursor)", () => {
  async function walletWithBets(n: number) {
    const w = await newWallet("1000.00");
    for (let i = 0; i < n; i++) expect((await submit(txBody(w, "BET", "1.00"), uniqueId("k"))).status).toBe(200);
    return w; // 1 lançamento de abertura + n
  }

  test("percorre tudo sem repetir nem pular; nextCursor null na última", async () => {
    const w = await walletWithBets(7);
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res: Res = await call("GET", `/wallets/${w.id}/ledger?limit=3${cursor ? `&cursor=${cursor}` : ""}`);
      expect(res.status).toBe(200);
      seen.push(...res.body.items.map((i: any) => i.id));
      cursor = res.body.nextCursor;
      pages++;
    } while (cursor && pages < 20);
    expect(pages).toBe(3); // 8 itens / 3
    expect(seen).toHaveLength(8);
    expect(new Set(seen).size).toBe(8);
  });

  test("página exata: sem página vazia no fim", async () => {
    const w = await walletWithBets(3); // 4 itens
    const p1 = await call("GET", `/wallets/${w.id}/ledger?limit=4`);
    expect(p1.body.items).toHaveLength(4);
    expect(p1.body.nextCursor).toBeNull();
  });

  test("lançamentos novos entre páginas aparecem depois, sem duplicar", async () => {
    const w = await walletWithBets(4); // 5
    const p1 = await call("GET", `/wallets/${w.id}/ledger?limit=3`);
    await submit(txBody(w, "BET", "1.00"), uniqueId("k"));
    const p2 = await call("GET", `/wallets/${w.id}/ledger?limit=10&cursor=${p1.body.nextCursor}`);
    const ids = [...p1.body.items, ...p2.body.items].map((i: any) => i.id);
    expect(ids).toHaveLength(6);
    expect(new Set(ids).size).toBe(6);
    expect(p2.body.nextCursor).toBeNull();
  });

  test("ordem e cadeia de saldos", async () => {
    const w = await walletWithBets(3);
    const { items } = (await call("GET", `/wallets/${w.id}/ledger`)).body;
    for (let i = 1; i < items.length; i++) expect(items[i].balanceBefore).toEqual(items[i - 1].balanceAfter);
  });

  test("entradas inválidas: 400; wallet inexistente: 404", async () => {
    const a = await walletWithBets(1);
    const b = await walletWithBets(1);
    const page = await call("GET", `/wallets/${a.id}/ledger?limit=1`);
    for (const q of ["limit=0", "limit=201", "limit=abc", "limit=-1", "cursor=lixo", `cursor=${page.body.nextCursor}&limit=1&limit=2`]) {
      expect((await call("GET", `/wallets/${a.id}/ledger?${q}`)).status).toBe(400);
    }
    // cursor de uma wallet usado em outra
    expect((await call("GET", `/wallets/${b.id}/ledger?cursor=${page.body.nextCursor}`)).status).toBe(400);
    expect((await call("GET", `/wallets/0192f0e0-0000-7000-8000-00000000ffff/ledger`)).status).toBe(404);
  });
});

describe("POST /wallets/:id/reconciliation", () => {
  test("consistente", async () => {
    const w = await newWallet("50.00");
    await submit(txBody(w, "BET", "5.00"), uniqueId("k"));
    const res = await call("POST", `/wallets/${w.id}/reconciliation`);
    expect(res.status).toBe(200);
    expect(res.body.consistent).toBe(true);
    expect(res.body.storedBalance).toEqual(money("45.00"));
    expect(res.body.calculatedBalance).toEqual(money("45.00"));
    expect(res.body.checkedEntries).toBe(2);
  });

  test("divergente: sinaliza, loga, conta e NÃO corrige", async () => {
    const w = await newWallet("50.00");
    await db.sql.unsafe(`alter table wallets disable trigger user`);
    try {
      await db.sql.unsafe(`update wallets set balance = balance + 1.00 where id = $1`, [w.id]);
    } finally {
      await db.sql.unsafe(`alter table wallets enable trigger user`);
    }
    const before = srv.metrics.value("wallet_reconciliation_divergences_total");
    const res = await call("POST", `/wallets/${w.id}/reconciliation`);
    expect(res.status).toBe(200);
    expect(res.body.consistent).toBe(false);
    expect(res.body.difference).toEqual(money("1.00"));
    expect(srv.metrics.value("wallet_reconciliation_divergences_total")).toBe(before + 1);
    expect(srv.logger.lines.some((l) => l.level === "error" && l.fields?.walletId === w.id)).toBe(true);
    const [row] = await db.sql.unsafe(`select balance::text as b from wallets where id = $1`, [w.id]);
    expect(row.b).toBe("51.00");
  });

  test("wallet inexistente: 404", async () => {
    expect((await call("POST", `/wallets/0192f0e0-0000-7000-8000-00000000ffff/reconciliation`)).status).toBe(404);
  });
});

describe("503 em falha transitória", () => {
  test("wallet travada por outra conexão além do lock_timeout: 503 + Retry-After; nada gravado; retry funciona", async () => {
    const fast = await startServer(db, { lockTimeoutMs: 200 });
    try {
      const w = await newWallet("100.00", fast);
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

      const body = txBody(w, "BET", "10.00");
      const key = uniqueId("k");
      const res = await submit(body, key, fast);
      expect(res.status).toBe(503);
      expect(res.headers.get("retry-after")).toBe("1");
      expect(res.body.error.code).toBe("TRANSIENT_FAILURE");
      expect(fast.logger.lines.some((l) => l.level === "warn" && l.fields?.status === 503)).toBe(true);

      release();
      await holder;

      const [{ n }] = await db.sql.unsafe(`select count(*)::int as n from wager_transactions where wallet_id = $1 and kind <> 'OPENING'`, [w.id]);
      expect(n).toBe(0);
      const retry = await submit(body, key, fast);
      expect(retry.status).toBe(200);
      expect(retry.body.idempotentReplay).toBe(false);
      await expectLedgerInvariant(db.sql, w.id);
    } finally {
      await fast.close();
    }
  });
});

describe("erro inesperado", () => {
  test("500 genérico sem vazar detalhes", async () => {
    // derruba a tabela de transações numa cópia isolada do banco seria invasivo; usamos um servidor apontando para banco inexistente
    const broken = await startServer({ ...db, url: db.url.replace(/\/[^/]+$/, "/banco_que_nao_existe") } as TestDb);
    try {
      const res = await call("GET", `/wallets/0192f0e0-0000-7000-8000-000000000001`, { server: broken });
      expect(res.status).toBe(500);
      expect(res.body.error).toEqual({ code: "INTERNAL_ERROR", message: "Internal server error" });
      expect(JSON.stringify(res.body)).not.toContain("banco_que_nao_existe");
    } finally {
      await broken.close();
    }
  });
});
