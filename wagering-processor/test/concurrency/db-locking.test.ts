import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { up } from "@/infrastructure/persistence/schema/initial-schema";

// Postgres REAL, várias conexões: valida o que o PGlite (conexão única) não consegue.
// Usa DATABASE_URL do .env e cria um banco descartável, sem tocar nos dados de desenvolvimento.

const baseUrl = process.env.DATABASE_URL ?? "postgresql://wagering:wagering@localhost:5432/wagering";
const dbName = `wagering_conc_${process.pid}_${Date.now()}`;
const urlFor = (name: string) => {
  const u = new URL(baseUrl);
  u.pathname = `/${name}`;
  return u.toString();
};

const uuid = () => crypto.randomUUID();
const HASH = "a".repeat(64);
const NOW = "2026-01-01T00:00:00Z";

let admin: SQL;
let sql: SQL;

beforeAll(async () => {
  admin = new SQL(baseUrl, { max: 1 });
  await admin.unsafe(`CREATE DATABASE ${dbName}`);
  sql = new SQL(urlFor(dbName), { max: 40 });
  for (const statement of up) await sql.unsafe(statement);
});

afterAll(async () => {
  await sql.close();
  await admin.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.close();
});

type Q = { unsafe: SQL["unsafe"] };

async function openWallet(balance: string) {
  const id = uuid();
  const playerId = `p-${id}`;
  await sql.begin(async (tx: Q) => {
    await tx.unsafe(
      `insert into wallets (id, player_id, currency, balance, version, created_at, updated_at) values ($1,$2,'BRL',$3,1,$4,$4)`,
      [id, playerId, balance, NOW],
    );
    const t = uuid();
    await tx.unsafe(
      `insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
         round_id, game_id, kind, amount, currency, status, created_at, processed_at)
       values ($1,'system',$2,$2,$3,$4,$5,'-','-','OPENING',$6,'BRL','PROCESSED',$7,$7)`,
      [t, `opening:${id}`, HASH, id, playerId, balance, NOW],
    );
    await tx.unsafe(
      `insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
       values ($1,$2,$3,'CREDIT',$4,'BRL',0,$4,$5)`,
      [uuid(), id, t, balance, NOW],
    );
  });
  return { id, playerId };
}

/** Débito com o protocolo do use case: lock da linha, decide, grava tudo na mesma transação. */
async function bet(wallet: { id: string; playerId: string }, amount: string): Promise<"PROCESSED" | "REJECTED"> {
  return sql.begin(async (tx: Q) => {
    const [row] = await tx.unsafe(`select balance, version from wallets where id = $1 for update`, [wallet.id]);
    const balance = Number(row.balance);
    const ext = uuid();
    const base = [uuid(), `prov:${ext}`, `prov:${ext}`, HASH, wallet.id, wallet.playerId, amount, NOW];
    const insertTx = (status: string, extra: string, extraVal: unknown[]) =>
      tx.unsafe(
        `insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
           round_id, game_id, kind, amount, currency, status, created_at, ${extra})
         values ($1,'provider-a',$2,$3,$4,$5,$6,'r','g','BET',$7,'BRL','${status}',$8, ${extraVal.map((_, i) => `$${9 + i}`).join(",")})`,
        [...base, ...extraVal],
      );
    if (balance < Number(amount)) {
      await insertTx("REJECTED", "failure_code", ["INSUFFICIENT_FUNDS"]);
      return "REJECTED";
    }
    const after = (balance - Number(amount)).toFixed(2);
    await insertTx("PROCESSED", "processed_at", [NOW]);
    await tx.unsafe(`update wallets set balance = $2, version = version + 1 where id = $1`, [wallet.id, after]);
    await tx.unsafe(
      `insert into wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, currency, balance_before, balance_after, created_at)
       values ($1,$2,$3,'DEBIT',$4,'BRL',$5,$6,$7)`,
      [uuid(), wallet.id, base[0], amount, row.balance, after, NOW],
    );
    return "PROCESSED";
  });
}

async function ledgerSum(walletId: string): Promise<string> {
  const [r] = await sql.unsafe(
    `select coalesce(sum(case direction when 'CREDIT' then amount else -amount end), 0)::text as total
       from wallet_ledger_entries where wallet_id = $1`,
    [walletId],
  );
  return r.total;
}

describe("Postgres real: concorrência por wallet", () => {
  test("cenário obrigatório: 100,00 e duas apostas de 80,00 simultâneas", async () => {
    const w = await openWallet("100.00");
    const results = await Promise.all([bet(w, "80.00"), bet(w, "80.00")]);

    expect(results.filter((r) => r === "PROCESSED")).toHaveLength(1);
    expect(results.filter((r) => r === "REJECTED")).toHaveLength(1);
    const [row] = await sql.unsafe(`select balance::text, version from wallets where id=$1`, [w.id]);
    expect(row.balance).toBe("20.00");
    expect(row.version).toBe(2);
    const [{ n }] = await sql.unsafe(`select count(*)::int n from wallet_ledger_entries where wallet_id=$1 and direction='DEBIT'`, [w.id]);
    expect(n).toBe(1);
    expect(await ledgerSum(w.id)).toBe("20.00"); // wallet.balance == saldo reconstruído pelo ledger
  });

  test("hot wallet: 60 apostas de 10,00 em paralelo sobre 100,00 => exatamente 10 passam, saldo 0,00", async () => {
    const w = await openWallet("100.00");
    const results = await Promise.all(Array.from({ length: 60 }, () => bet(w, "10.00")));

    expect(results.filter((r) => r === "PROCESSED")).toHaveLength(10);
    const [row] = await sql.unsafe(`select balance::text, version from wallets where id=$1`, [w.id]);
    expect(row.balance).toBe("0.00");
    expect(row.version).toBe(11);
    expect(await ledgerSum(w.id)).toBe("0.00");
  });

  test("wallets distintas em paralelo não se bloqueiam nem se misturam", async () => {
    const wallets = await Promise.all(Array.from({ length: 10 }, () => openWallet("100.00")));
    await Promise.all(wallets.flatMap((w) => [bet(w, "30.00"), bet(w, "30.00"), bet(w, "30.00"), bet(w, "30.00")]));
    for (const w of wallets) {
      const [row] = await sql.unsafe(`select balance::text from wallets where id=$1`, [w.id]);
      expect(row.balance).toBe("10.00");
      expect(await ledgerSum(w.id)).toBe("10.00");
    }
  });
});

describe("Postgres real: idempotência", () => {
  test("a mesma transação inserida 50 vezes em paralelo: um único vencedor", async () => {
    const w = await openWallet("100.00");
    const ext = uuid();
    const insert = () =>
      sql.unsafe(
        `insert into wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
           round_id, game_id, kind, amount, currency, status, created_at)
         values ($1,'provider-a',$2,$3,$4,$5,$6,'r','g','BET',25.00,'BRL','PENDING',$7)
         on conflict do nothing returning id`,
        [uuid(), ext, `provider-a:${ext}`, HASH, w.id, w.playerId, NOW],
      );
    const results = await Promise.all(Array.from({ length: 50 }, insert));
    expect(results.filter((r) => r.length === 1)).toHaveLength(1);
    const [{ n }] = await sql.unsafe(`select count(*)::int n from wager_transactions where external_transaction_id=$1`, [ext]);
    expect(n).toBe(1);
  });
});

describe("Postgres real: outbox com publishers concorrentes", () => {
  test("FOR UPDATE SKIP LOCKED entrega lotes disjuntos a duas conexões simultâneas", async () => {
    const agg = `agg-${uuid()}`;
    const ids = Array.from({ length: 6 }, () => uuid());
    for (const id of ids) {
      await sql.unsafe(
        `insert into outbox_messages (id, aggregate_id, event_type, payload, occurred_at) values ($1,$2,'E','{}'::jsonb,$3)`,
        [id, agg, NOW],
      );
    }
    const claim = (tx: Q) =>
      tx.unsafe(
        `select id from outbox_messages where published_at is null and aggregate_id=$1 and next_attempt_at <= now()
         order by seq limit 3 for update skip locked`,
        [agg],
      );

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let firstClaimed!: () => void;
    const firstReady = new Promise<void>((r) => (firstClaimed = r));

    // publisher A segura o lote (transação aberta) enquanto B tenta pegar o dele
    const a = sql.begin(async (tx: Q) => {
      const rows = await claim(tx);
      firstClaimed();
      await gate;
      return rows.map((r: { id: string }) => r.id);
    });
    await firstReady;
    const b = await sql.begin(async (tx: Q) => (await claim(tx)).map((r: { id: string }) => r.id));
    release();
    const aIds = await a;

    expect(aIds).toHaveLength(3);
    expect(b).toHaveLength(3);
    expect(new Set([...aIds, ...b]).size).toBe(6); // sem sobreposição
  });

  test("publisher que morre (rollback) devolve o lote: outra instância assume", async () => {
    const agg = `agg-${uuid()}`;
    const id = uuid();
    await sql.unsafe(`insert into outbox_messages (id, aggregate_id, event_type, payload, occurred_at) values ($1,$2,'E','{}'::jsonb,$3)`, [id, agg, NOW]);

    await expect(
      sql.begin(async (tx: Q) => {
        const rows = await tx.unsafe(`select id from outbox_messages where aggregate_id=$1 for update skip locked`, [agg]);
        expect(rows).toHaveLength(1);
        throw new Error("processo morreu antes de marcar published_at");
      }),
    ).rejects.toThrow();

    const rows = await sql.begin((tx: Q) =>
      tx.unsafe(`select id from outbox_messages where aggregate_id=$1 and published_at is null for update skip locked`, [agg]),
    );
    expect(rows).toHaveLength(1);
  });
});
