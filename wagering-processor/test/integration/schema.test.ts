import { beforeAll, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { allDown, allUp } from "@/infrastructure/persistence/schema";

// PGlite = PostgreSQL real (WASM). Valida constraints, triggers e índices de verdade.
// A concorrência entre conexões/processos é testada à parte, contra o Postgres do Docker.

const uuid = () => crypto.randomUUID();
const HASH = "a".repeat(64);
const NOW = "2026-01-01T00:00:00Z";

async function applyUp(db: PGlite) {
  for (const s of allUp) await db.exec(s);
}

async function insert(db: PGlite | { query: PGlite["query"] }, table: string, row: Record<string, unknown>) {
  const cols = Object.keys(row);
  const sql = `insert into ${table} (${cols.join(",")}) values (${cols.map((_, i) => `$${i + 1}`).join(",")})`;
  return db.query(sql, Object.values(row));
}

/** Espera falha citando a constraint/trigger pelo nome (documenta qual garantia segurou). */
async function expectViolation(promise: Promise<unknown>, fragment: string) {
  let error: unknown;
  try {
    await promise;
  } catch (e) {
    error = e;
  }
  expect(error).toBeDefined();
  expect(String((error as Error).message)).toContain(fragment);
}

type Tx = { query: PGlite["query"]; exec: PGlite["exec"] };

const walletRow = (o: Record<string, unknown> = {}) => ({
  id: uuid(), player_id: `p-${uuid()}`, currency: "BRL", balance: "0.00", version: 1, created_at: NOW, updated_at: NOW, ...o,
});

const txRow = (walletId: string, playerId: string, o: Record<string, unknown> = {}) => {
  const ext = uuid();
  return {
    id: uuid(), provider_id: "provider-a", external_transaction_id: ext, idempotency_key: `provider-a:${ext}`,
    payload_hash: HASH, wallet_id: walletId, player_id: playerId, round_id: "r1", game_id: "g1",
    kind: "BET", amount: "25.00", currency: "BRL", status: "PENDING", created_at: NOW, ...o,
  };
};

const entryRow = (walletId: string, txId: string, o: Record<string, unknown> = {}) => ({
  id: uuid(), wallet_id: walletId, transaction_id: txId, direction: "CREDIT", amount: "100.00", currency: "BRL",
  balance_before: "0.00", balance_after: "100.00", created_at: NOW, ...o,
});

/** Abre wallet com saldo via OPENING + lançamento, tudo na mesma transação (como o use case fará). */
async function openWallet(db: PGlite, balance = "100.00") {
  const w = walletRow({ balance });
  const opening = txRow(w.id, w.player_id, {
    kind: "OPENING", amount: balance, status: "PROCESSED", processed_at: NOW,
  });
  await db.transaction(async (tx) => {
    await insert(tx, "wallets", w);
    await insert(tx, "wager_transactions", opening);
    await insert(tx, "wallet_ledger_entries", entryRow(w.id, opening.id, { amount: balance, balance_after: balance }));
  });
  return w;
}

describe("migration reversível", () => {
  test("up -> down -> up", async () => {
    const db = new PGlite();
    await applyUp(db);
    const tables = async () =>
      (await db.query<{ t: string }>(`select table_name t from information_schema.tables where table_schema='public' order by 1`)).rows.map((r) => r.t);
    expect(await tables()).toEqual(["inbox_messages", "outbox_messages", "wager_transactions", "wallet_ledger_entries", "wallets"]);

    for (const s of allDown) await db.exec(s);
    expect(await tables()).toEqual([]);
    const fns = await db.query(`select proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'`);
    expect(fns.rows).toEqual([]);

    await applyUp(db);
    expect((await tables()).length).toBe(5);
    await db.close();
  });
});

describe("constraints no schema", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = new PGlite();
    await applyUp(db);
  });

  describe("wallets", () => {
    test("saldo negativo é rejeitado", async () => {
      await expectViolation(insert(db, "wallets", walletRow({ balance: "-0.01" })), "wallets_balance_non_negative");
    });

    test("uma wallet por (player, moeda); outra moeda do mesmo player é permitida", async () => {
      const w = walletRow();
      await insert(db, "wallets", w);
      await expectViolation(insert(db, "wallets", walletRow({ player_id: w.player_id })), "wallets_player_currency_key");
      await insert(db, "wallets", walletRow({ player_id: w.player_id, currency: "USD" }));
    });

    test("moeda mal formada e version < 1", async () => {
      await expectViolation(insert(db, "wallets", walletRow({ currency: "br1" })), "wallets_currency_format");
      await expectViolation(insert(db, "wallets", walletRow({ version: 0 })), "wallets_version_positive");
    });

    test("UPDATE que deixaria saldo negativo falha (CHECK, sem depender da aplicação)", async () => {
      const w = await openWallet(db, "20.00");
      await expectViolation(db.query(`update wallets set balance = balance - 80 where id = $1`, [w.id]), "wallets_balance_non_negative");
    });
  });

  describe("wager_transactions: idempotência e unicidade", () => {
    test("mesma idempotency_key é rejeitada", async () => {
      const w = walletRow();
      await insert(db, "wallets", w);
      const a = txRow(w.id, w.player_id);
      await insert(db, "wager_transactions", a);
      await expectViolation(
        insert(db, "wager_transactions", txRow(w.id, w.player_id, { idempotency_key: a.idempotency_key })),
        "wager_tx_idempotency_key_key",
      );
    });

    test("mesmo (provider, external id) é rejeitado; outro provider é permitido", async () => {
      const w = walletRow();
      await insert(db, "wallets", w);
      const a = txRow(w.id, w.player_id);
      await insert(db, "wager_transactions", a);
      await expectViolation(
        insert(db, "wager_transactions", txRow(w.id, w.player_id, { external_transaction_id: a.external_transaction_id })),
        "wager_tx_provider_external_key",
      );
      await insert(
        db,
        "wager_transactions",
        txRow(w.id, w.player_id, { provider_id: "provider-b", external_transaction_id: a.external_transaction_id }),
      );
    });

    test("50 INSERTs idênticos em paralelo: exatamente um vence", async () => {
      const w = walletRow();
      await insert(db, "wallets", w);
      const base = txRow(w.id, w.player_id);
      const results = await Promise.allSettled(
        Array.from({ length: 50 }, () => insert(db, "wager_transactions", { ...base, id: uuid() })),
      );
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    });
  });

  describe("wager_transactions: regras de forma", () => {
    let w: ReturnType<typeof walletRow>;
    beforeAll(async () => {
      w = walletRow();
      await insert(db, "wallets", w);
    });

    test("moeda diferente da wallet (FK composta)", async () => {
      await expectViolation(insert(db, "wager_transactions", txRow(w.id, w.player_id, { currency: "USD" })), "wager_tx_wallet_currency_fk");
    });

    test("player diferente do dono da wallet (FK composta)", async () => {
      await expectViolation(insert(db, "wager_transactions", txRow(w.id, "outro-player")), "wager_tx_wallet_player_fk");
    });

    test("REFUND/ROLLBACK sem referência; BET com referência", async () => {
      await expectViolation(insert(db, "wager_transactions", txRow(w.id, w.player_id, { kind: "REFUND" })), "wager_tx_reference_by_kind");
      await expectViolation(insert(db, "wager_transactions", txRow(w.id, w.player_id, { kind: "ROLLBACK" })), "wager_tx_reference_by_kind");
      await expectViolation(
        insert(db, "wager_transactions", txRow(w.id, w.player_id, { reference_external_transaction_id: "x" })),
        "wager_tx_reference_by_kind",
      );
    });

    test("valor zero só é permitido em LOSS; negativo nunca", async () => {
      await expectViolation(insert(db, "wager_transactions", txRow(w.id, w.player_id, { amount: "0.00" })), "wager_tx_amount_valid");
      await expectViolation(insert(db, "wager_transactions", txRow(w.id, w.player_id, { amount: "-1.00" })), "wager_tx_amount_valid");
      await insert(db, "wager_transactions", txRow(w.id, w.player_id, { kind: "LOSS", amount: "0.00" }));
    });

    test("status x failure_code x processed_at precisam ser coerentes", async () => {
      await expectViolation(insert(db, "wager_transactions", txRow(w.id, w.player_id, { status: "REJECTED" })), "wager_tx_failure_code_by_status");
      await expectViolation(
        insert(db, "wager_transactions", txRow(w.id, w.player_id, { status: "PENDING", failure_code: "INSUFFICIENT_FUNDS" })),
        "wager_tx_failure_code_by_status",
      );
      await expectViolation(insert(db, "wager_transactions", txRow(w.id, w.player_id, { status: "PROCESSED" })), "wager_tx_processed_at_by_status");
      await insert(
        db,
        "wager_transactions",
        txRow(w.id, w.player_id, { status: "REJECTED", failure_code: "INSUFFICIENT_FUNDS" }),
      );
    });

    test("hash precisa ser sha-256 hex", async () => {
      await expectViolation(insert(db, "wager_transactions", txRow(w.id, w.player_id, { payload_hash: "XYZ".padEnd(64, "z") })), "wager_tx_hash_format");
    });
  });

  describe("reversão única por tipo", () => {
    async function betProcessed(wallet: ReturnType<typeof walletRow>) {
      const bet = txRow(wallet.id, wallet.player_id, { status: "PROCESSED", processed_at: NOW });
      await insert(db, "wager_transactions", bet);
      return bet;
    }
    const reversal = (wallet: ReturnType<typeof walletRow>, bet: { id: string; external_transaction_id: string }, o: Record<string, unknown> = {}) =>
      txRow(wallet.id, wallet.player_id, {
        kind: "REFUND", reference_external_transaction_id: bet.external_transaction_id, reference_transaction_id: bet.id,
        status: "PROCESSED", processed_at: NOW, ...o,
      });

    test("dois REFUND processados da mesma BET: o segundo falha", async () => {
      const w = walletRow();
      await insert(db, "wallets", w);
      const bet = await betProcessed(w);
      await insert(db, "wager_transactions", reversal(w, bet));
      await expectViolation(insert(db, "wager_transactions", reversal(w, bet)), "wager_tx_one_reversal_per_reference");
    });

    test("REFUND e ROLLBACK da MESMA BET não coexistem: creditaria duas vezes (migration 002)", async () => {
      const w = walletRow();
      await insert(db, "wallets", w);
      const bet = await betProcessed(w);
      await insert(db, "wager_transactions", reversal(w, bet));
      await expectViolation(
        insert(db, "wager_transactions", reversal(w, bet, { kind: "ROLLBACK" })),
        "wager_tx_one_reversal_per_reference",
      );
    });

    test("ROLLBACK do REFUND é outra referência: continua permitido", async () => {
      const w = walletRow();
      await insert(db, "wallets", w);
      const bet = await betProcessed(w);
      const refund = reversal(w, bet);
      await insert(db, "wager_transactions", refund);
      await insert(db, "wager_transactions", reversal(w, refund, { kind: "ROLLBACK" }));
    });

    test("tentativa REJECTED não consome a vaga de reversão", async () => {
      const w = walletRow();
      await insert(db, "wallets", w);
      const bet = await betProcessed(w);
      await insert(
        db,
        "wager_transactions",
        reversal(w, bet, { status: "REJECTED", failure_code: "AMOUNT_MISMATCH", processed_at: null }),
      );
      await insert(db, "wager_transactions", reversal(w, bet));
    });

    test("reversão PROCESSED sem reference_transaction_id é rejeitada", async () => {
      const w = walletRow();
      await insert(db, "wallets", w);
      const bet = await betProcessed(w);
      await expectViolation(
        insert(db, "wager_transactions", reversal(w, bet, { reference_transaction_id: null })),
        "wager_tx_reversal_has_reference",
      );
    });
  });

  describe("guardas de transição (trigger)", () => {
    async function pending(status = "PENDING", extra: Record<string, unknown> = {}) {
      const w = walletRow();
      await insert(db, "wallets", w);
      const t = txRow(w.id, w.player_id, { kind: "REFUND", reference_external_transaction_id: "ref", status, ...extra });
      await insert(db, "wager_transactions", t);
      return t;
    }

    test("PENDING -> PENDING_REFERENCE -> REJECTED é permitido", async () => {
      const t = await pending();
      await db.query(`update wager_transactions set status='PENDING_REFERENCE', reference_attempts=1 where id=$1`, [t.id]);
      await db.query(`update wager_transactions set reference_attempts=2 where id=$1`, [t.id]);
      await db.query(`update wager_transactions set status='REJECTED', failure_code='REFERENCE_NOT_FOUND' where id=$1`, [t.id]);
    });

    test("estado terminal não muda mais", async () => {
      const t = await pending("REJECTED", { failure_code: "AMOUNT_MISMATCH" });
      await expectViolation(db.query(`update wager_transactions set status='PROCESSED', failure_code=null, processed_at=now() where id=$1`, [t.id]), "terminal status");
      await expectViolation(db.query(`update wager_transactions set failure_code='OTHER' where id=$1`, [t.id]), "terminal status");
    });

    test("PENDING_REFERENCE não volta para PENDING", async () => {
      const t = await pending();
      await db.query(`update wager_transactions set status='PENDING_REFERENCE' where id=$1`, [t.id]);
      await expectViolation(db.query(`update wager_transactions set status='PENDING' where id=$1`, [t.id]), "cannot go back");
    });

    test("colunas de identidade são imutáveis (valor, payload_hash, key...)", async () => {
      const t = await pending();
      await expectViolation(db.query(`update wager_transactions set amount = 999 where id=$1`, [t.id]), "identity columns are immutable");
      await expectViolation(db.query(`update wager_transactions set payload_hash = $2 where id=$1`, [t.id, "b".repeat(64)]), "identity columns are immutable");
      await expectViolation(db.query(`update wager_transactions set idempotency_key = 'x' where id=$1`, [t.id]), "identity columns are immutable");
    });

    test("transações não podem ser apagadas", async () => {
      const t = await pending();
      await expectViolation(db.query(`delete from wager_transactions where id=$1`, [t.id]), "append-only");
    });
  });

  describe("ledger", () => {
    test("UPDATE e DELETE são bloqueados pelo banco", async () => {
      const w = await openWallet(db, "100.00");
      const { rows } = await db.query<{ id: string }>(`select id from wallet_ledger_entries where wallet_id=$1`, [w.id]);
      const id = rows[0]!.id;
      await expectViolation(db.query(`update wallet_ledger_entries set amount = 1 where id=$1`, [id]), "append-only");
      await expectViolation(db.query(`delete from wallet_ledger_entries where id=$1`, [id]), "append-only");
    });

    test("aritmética inconsistente é rejeitada", async () => {
      const w = walletRow();
      await insert(db, "wallets", w);
      const t = txRow(w.id, w.player_id, { kind: "OPENING", amount: "100.00", status: "PROCESSED", processed_at: NOW });
      await insert(db, "wager_transactions", t);
      await expectViolation(
        insert(db, "wallet_ledger_entries", entryRow(w.id, t.id, { balance_after: "99.00" })),
        "ledger_arithmetic",
      );
      await expectViolation(
        insert(db, "wallet_ledger_entries", entryRow(w.id, t.id, { direction: "DEBIT" })),
        "ledger_",
      );
    });

    test("valor zero ou saldo negativo no lançamento", async () => {
      const w = walletRow();
      await insert(db, "wallets", w);
      const t = txRow(w.id, w.player_id, { kind: "OPENING", amount: "1.00", status: "PROCESSED", processed_at: NOW });
      await insert(db, "wager_transactions", t);
      await expectViolation(insert(db, "wallet_ledger_entries", entryRow(w.id, t.id, { amount: "0.00", balance_after: "0.00" })), "ledger_amount_positive");
      await expectViolation(
        insert(db, "wallet_ledger_entries", entryRow(w.id, t.id, { direction: "DEBIT", balance_before: "0.00", balance_after: "-100.00" })),
        "ledger_balances_non_negative",
      );
    });

    test("no máximo um lançamento por transação e wallet", async () => {
      const w = await openWallet(db, "100.00");
      const { rows } = await db.query<{ transaction_id: string }>(`select transaction_id from wallet_ledger_entries where wallet_id=$1`, [w.id]);
      await expectViolation(
        insert(db, "wallet_ledger_entries", entryRow(w.id, rows[0]!.transaction_id, { balance_before: "100.00", balance_after: "200.00" })),
        "ledger_wallet_transaction_key",
      );
    });

    test("lançamento precisa pertencer à mesma wallet da transação (FK composta)", async () => {
      const w1 = walletRow();
      const w2 = walletRow();
      await insert(db, "wallets", w1);
      await insert(db, "wallets", w2);
      const t = txRow(w1.id, w1.player_id, { kind: "OPENING", amount: "10.00", status: "PROCESSED", processed_at: NOW });
      await insert(db, "wager_transactions", t);
      await expectViolation(
        insert(db, "wallet_ledger_entries", entryRow(w2.id, t.id, { amount: "10.00", balance_after: "10.00" })),
        "ledger_transaction_wallet_fk",
      );
    });

    test("encadeamento: balance_before precisa ser o balance_after anterior", async () => {
      const w = await openWallet(db, "100.00");
      const bet = txRow(w.id, w.player_id, { status: "PROCESSED", processed_at: NOW });
      await insert(db, "wager_transactions", bet);
      await expectViolation(
        insert(db, "wallet_ledger_entries", entryRow(w.id, bet.id, { direction: "DEBIT", amount: "25.00", balance_before: "90.00", balance_after: "65.00" })),
        "ledger chain broken",
      );
    });
  });

  describe("saldo materializado == ledger (verificado no COMMIT)", () => {
    test("wallet + OPENING + lançamento na mesma transação: ok", async () => {
      await openWallet(db, "1000.00");
    });

    test("débito completo (UPDATE do saldo + lançamento): ok", async () => {
      const w = await openWallet(db, "100.00");
      const bet = txRow(w.id, w.player_id, { status: "PROCESSED", processed_at: NOW });
      await db.transaction(async (tx) => {
        await insert(tx, "wager_transactions", bet);
        await tx.query(`update wallets set balance = 75.00, version = version + 1 where id=$1`, [w.id]);
        await insert(tx, "wallet_ledger_entries", entryRow(w.id, bet.id, { direction: "DEBIT", amount: "25.00", balance_before: "100.00", balance_after: "75.00" }));
      });
      expect((await db.query<{ balance: string }>(`select balance from wallets where id=$1`, [w.id])).rows[0]!.balance).toBe("75.00");
    });

    test("saldo alterado SEM lançamento: o COMMIT falha e nada persiste", async () => {
      const w = await openWallet(db, "100.00");
      await expectViolation(
        db.transaction(async (tx) => {
          await tx.query(`update wallets set balance = 50.00, version = version + 1 where id=$1`, [w.id]);
        }),
        "does not match ledger",
      );
      expect((await db.query<{ balance: string }>(`select balance from wallets where id=$1`, [w.id])).rows[0]!.balance).toBe("100.00");
    });

    test("lançamento SEM atualizar o saldo: o COMMIT falha", async () => {
      const w = await openWallet(db, "100.00");
      const bet = txRow(w.id, w.player_id, { status: "PROCESSED", processed_at: NOW });
      await expectViolation(
        db.transaction(async (tx) => {
          await insert(tx, "wager_transactions", bet);
          await insert(tx, "wallet_ledger_entries", entryRow(w.id, bet.id, { direction: "DEBIT", amount: "25.00", balance_before: "100.00", balance_after: "75.00" }));
        }),
        "does not match ledger",
      );
      const t = await db.query(`select 1 from wager_transactions where id=$1`, [bet.id]);
      expect(t.rows).toHaveLength(0); // a transação financeira também foi desfeita: atomicidade
    });

    test("wallet criada com saldo > 0 e sem OPENING/lançamento: o COMMIT falha", async () => {
      await expectViolation(
        db.transaction(async (tx) => {
          await insert(tx, "wallets", walletRow({ balance: "500.00" }));
        }),
        "does not match ledger",
      );
    });
  });

  describe("inbox e outbox", () => {
    test("inbox: (consumer, message_id) é único; outro consumer pode receber o mesmo id", async () => {
      const row = { consumer_name: "wager-consumer", message_id: "msg-1", payload_hash: HASH, received_at: NOW };
      await insert(db, "inbox_messages", row);
      await expectViolation(insert(db, "inbox_messages", row), "inbox_pkey");
      await insert(db, "inbox_messages", { ...row, consumer_name: "outro" });
    });

    test("inbox: ON CONFLICT DO NOTHING devolve 0 linhas para duplicata", async () => {
      const args = ["wager-consumer", "msg-2", HASH, NOW];
      const sql = `insert into inbox_messages (consumer_name, message_id, payload_hash, received_at)
                   values ($1,$2,$3,$4) on conflict do nothing`;
      expect((await db.query(sql, args)).affectedRows).toBe(1);
      expect((await db.query(sql, args)).affectedRows).toBe(0);
    });

    test("outbox: payload jsonb, next_attempt_at default e attempts não negativo", async () => {
      const id = uuid();
      await insert(db, "outbox_messages", {
        id, aggregate_id: "w1", event_type: "WalletBalanceChanged", payload: JSON.stringify({ eventId: id }), occurred_at: NOW,
      });
      const { rows } = await db.query<{ attempts: number; next_attempt_at: Date; published_at: null }>(
        `select attempts, next_attempt_at, published_at from outbox_messages where id=$1`, [id],
      );
      expect(rows[0]!.attempts).toBe(0);
      expect(rows[0]!.next_attempt_at).toBeInstanceOf(Date);
      expect(rows[0]!.published_at).toBeNull();
      await expectViolation(db.query(`update outbox_messages set attempts = -1 where id=$1`, [id]), "outbox_attempts_non_negative");
    });

    test("outbox: SKIP LOCKED entrega linhas diferentes a publishers concorrentes", async () => {
      const ids = Array.from({ length: 4 }, () => uuid());
      for (const id of ids) {
        await insert(db, "outbox_messages", { id, aggregate_id: "agg-skip", event_type: "E", payload: "{}", occurred_at: NOW, next_attempt_at: "2000-01-01T00:00:00Z" });
      }
      const claim = `select id from outbox_messages where published_at is null and aggregate_id='agg-skip'
                     order by occurred_at, id limit 2 for update skip locked`;
      // (PGlite tem uma única conexão: aqui só se valida que a sintaxe/índice funcionam.
      //  O teste com dois publishers reais fica nos testes de concorrência, contra o Postgres do Docker.)
      const { rows } = await db.query(claim);
      expect(rows.length).toBe(2);
    });
  });
});
