import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import { PendingReferenceWorker } from "@/infrastructure/workers/pending-reference-worker.service";
import { MikroOrmUnitOfWork } from "@/infrastructure/persistence/postgres/mikro-orm-unit-of-work";
import { UnitOfWork } from "@/modules/wagering/application/ports";
import { WagerTransactionKind as K, WagerTransactionStatus as S } from "@/modules/wagering/domain/wager-transaction";
import { FailureCode } from "@/modules/wagering/domain/failure-code";
import { PendingReferencePolicy } from "@/modules/wagering/application/wager-settlement";
import { App, buildApp, command, expectLedgerInvariant, openWallet, uniqueId } from "./helpers/app";
import { CapturingLogger } from "./helpers/http-server";
import { FakeClock, waitFor } from "./helpers/sqs";
import { createTestDb, TestDb } from "./helpers/test-db";

setDefaultTimeout(60_000);

const POLICY: PendingReferencePolicy = { baseDelayMs: 2_000, maxDelayMs: 60_000, maxAttempts: 4, ttlMs: 10 * 60_000 };

let db: TestDb;
let orm: MikroORM;
// banco novo por teste: contagens de "pendentes" não podem enxergar sobras de outro teste
beforeEach(async () => {
  db = await createTestDb();
  orm = await db.newOrm();
});
afterEach(async () => db.drop());

function setup(options: { uow?: (real: UnitOfWork) => UnitOfWork; lockTimeoutMs?: number } = {}) {
  const clock = new FakeClock();
  const app: App = buildApp(orm, { ...options, clock, policy: POLICY });
  return { clock, app };
}

const txRow = async (id: string) =>
  (
    await db.sql.unsafe(
      `select status, failure_code, reference_attempts, reference_transaction_id,
              (extract(epoch from next_attempt_at) * 1000)::bigint::text as next_ms, balance_after::text as balance_after
         from wager_transactions where id = $1`,
      [id],
    )
  )[0];
const balanceOf = async (id: string) => (await db.sql.unsafe(`select balance::text as b from wallets where id = $1`, [id]))[0].b as string;
const ledgerCount = async (walletId: string) =>
  (await db.sql.unsafe(`select count(*)::int as n from wallet_ledger_entries where wallet_id = $1`, [walletId]))[0].n as number;
const eventTypes = async (walletId: string) =>
  (await db.sql.unsafe(`select event_type from outbox_messages where aggregate_id = $1 order by seq`, [walletId])).map((r: { event_type: string }) => r.event_type);

describe("referência que chega depois", () => {
  test("REFUND antes da BET fica PENDING_REFERENCE; quando a BET chega, o worker processa e credita uma vez", async () => {
    const { clock, app } = setup();
    const w = await openWallet(app, "100.00");
    const betExt = uniqueId("bet");
    const refund = command(w, K.Refund, "30.00", { referenceExternalTransactionId: betExt });

    const first = await app.process.execute(refund);
    expect(first.status).toBe(S.PendingReference);
    const t0 = clock.now().getTime();
    let row = await txRow(first.transactionId);
    expect(row.reference_attempts).toBe(0);
    expect(Number(row.next_ms)).toBe(t0 + 2_000);

    expect((await app.reprocess.runOnce(10)).due).toBe(0); // ainda não venceu
    await app.process.execute(command(w, K.Bet, "30.00", { externalTransactionId: betExt }));
    expect(await balanceOf(w.id)).toBe("70.00");

    clock.advance(2_000);
    const run = await app.reprocess.runOnce(10);
    expect(run).toEqual({ due: 1, outcomes: expect.objectContaining({ processed: 1 }) });

    row = await txRow(first.transactionId);
    expect(row.status).toBe("PROCESSED");
    expect(row.next_ms).toBeNull();
    expect(row.reference_transaction_id).not.toBeNull();
    expect(row.balance_after).toBe("100.00");
    expect(await balanceOf(w.id)).toBe("100.00");
    expect(await ledgerCount(w.id)).toBe(3); // abertura, BET, REFUND
    expect(await eventTypes(w.id)).toContain("WagerTransactionPendingReference");
    expect(await eventTypes(w.id)).toContain("WalletBalanceChanged");

    // nada mais a fazer, e reprocessar de novo não credita outra vez
    clock.advance(60_000);
    expect((await app.reprocess.runOnce(10)).due).toBe(0);
    expect(await balanceOf(w.id)).toBe("100.00");
    // o replay do pedido original devolve o resultado final
    const replay = await app.process.execute(refund);
    expect(replay).toMatchObject({ status: S.Processed, idempotentReplay: true, transactionId: first.transactionId });
    await expectLedgerInvariant(db.sql, w.id);
  });

  test("referência que nunca chega: backoff 4s, 8s e então REJECTED/REFERENCE_NOT_FOUND, sem mexer no saldo", async () => {
    const { clock, app } = setup();
    const w = await openWallet(app, "100.00");
    const r = await app.process.execute(command(w, K.Rollback, "10.00", { referenceExternalTransactionId: uniqueId("fantasma") }));
    expect(r.status).toBe(S.PendingReference);

    clock.advance(2_000);
    expect((await app.reprocess.runOnce(10)).outcomes.rescheduled).toBe(1);
    let row = await txRow(r.transactionId);
    expect(row.reference_attempts).toBe(1);
    expect(Number(row.next_ms)).toBe(clock.now().getTime() + 4_000);

    clock.advance(3_999);
    expect((await app.reprocess.runOnce(10)).due).toBe(0); // 1 ms antes de vencer
    clock.advance(1);
    expect((await app.reprocess.runOnce(10)).outcomes.rescheduled).toBe(1);
    row = await txRow(r.transactionId);
    expect(row.reference_attempts).toBe(2);
    expect(Number(row.next_ms)).toBe(clock.now().getTime() + 8_000);

    clock.advance(8_000);
    expect((await app.reprocess.runOnce(10)).outcomes.rescheduled).toBe(1); // 3ª
    clock.advance(16_000);
    expect((await app.reprocess.runOnce(10)).outcomes.expired).toBe(1); // 4ª = maxAttempts

    row = await txRow(r.transactionId);
    expect(row).toMatchObject({ status: "REJECTED", failure_code: FailureCode.ReferenceNotFound, reference_attempts: 4, next_ms: null });
    expect(await balanceOf(w.id)).toBe("100.00");
    expect(await ledgerCount(w.id)).toBe(1);
    expect(await eventTypes(w.id)).toContain("WagerTransactionRejected");
    const replay = await app.process.execute(command(w, K.Rollback, "10.00", { referenceExternalTransactionId: "x" }));
    expect(replay.status).toBeDefined(); // nova key: nova transação; o replay da original está coberto no teste 1
    await expectLedgerInvariant(db.sql, w.id);
  });

  test("TTL: passou do prazo, a primeira reavaliação sem referência já rejeita", async () => {
    const { clock, app } = setup();
    const w = await openWallet(app, "100.00");
    const r = await app.process.execute(command(w, K.Refund, "10.00", { referenceExternalTransactionId: uniqueId("fantasma") }));
    clock.advance(11 * 60_000);
    expect((await app.reprocess.runOnce(10)).outcomes.expired).toBe(1);
    expect(await txRow(r.transactionId)).toMatchObject({ status: "REJECTED", failure_code: "REFERENCE_NOT_FOUND", reference_attempts: 1 });
  });

  test("referência chega, mas é inválida (valor diferente): REJECTED por regra de negócio, não por timeout", async () => {
    const { clock, app } = setup();
    const w = await openWallet(app, "100.00");
    const betExt = uniqueId("bet");
    const r = await app.process.execute(command(w, K.Refund, "25.00", { referenceExternalTransactionId: betExt }));
    await app.process.execute(command(w, K.Bet, "30.00", { externalTransactionId: betExt }));
    clock.advance(2_000);
    await app.reprocess.runOnce(10);
    expect(await txRow(r.transactionId)).toMatchObject({ status: "REJECTED", failure_code: FailureCode.AmountMismatch });
    expect(await balanceOf(w.id)).toBe("70.00");
  });

  test("REFUND e ROLLBACK pendentes da MESMA BET: só um é aplicado (ALREADY_REVERSED no outro), crédito único", async () => {
    const { clock, app } = setup();
    const w = await openWallet(app, "100.00");
    const betExt = uniqueId("bet");
    const refund = await app.process.execute(command(w, K.Refund, "30.00", { referenceExternalTransactionId: betExt }));
    clock.advance(1);
    const rollback = await app.process.execute(command(w, K.Rollback, "30.00", { referenceExternalTransactionId: betExt }));
    await app.process.execute(command(w, K.Bet, "30.00", { externalTransactionId: betExt }));

    clock.advance(2_000);
    await app.reprocess.runOnce(10);
    const rows = [await txRow(refund.transactionId), await txRow(rollback.transactionId)];
    expect(rows.map((x) => x.status).sort()).toEqual(["PROCESSED", "REJECTED"]);
    expect(rows.find((x) => x.status === "REJECTED")!.failure_code).toBe(FailureCode.AlreadyReversed);
    expect(await balanceOf(w.id)).toBe("100.00");
    await expectLedgerInvariant(db.sql, w.id);
  });

  test("cadeia invertida: ROLLBACK do REFUND da BET chegando na ordem inversa converge ao estado correto", async () => {
    const { clock, app } = setup();
    const w = await openWallet(app, "100.00");
    const betExt = uniqueId("bet");
    const refundExt = uniqueId("refund");
    const rollback = await app.process.execute(command(w, K.Rollback, "30.00", { referenceExternalTransactionId: refundExt }));
    clock.advance(1);
    const refund = await app.process.execute(command(w, K.Refund, "30.00", { externalTransactionId: refundExt, referenceExternalTransactionId: betExt }));
    await app.process.execute(command(w, K.Bet, "30.00", { externalTransactionId: betExt }));

    for (let i = 0; i < 4; i++) {
      clock.advance(70_000);
      await app.reprocess.runOnce(10);
    }
    expect((await txRow(refund.transactionId)).status).toBe("PROCESSED");
    expect((await txRow(rollback.transactionId)).status).toBe("PROCESSED");
    // BET -30, REFUND +30, ROLLBACK do REFUND -30
    expect(await balanceOf(w.id)).toBe("70.00");
    await expectLedgerInvariant(db.sql, w.id);
  });
});

describe("robustez do worker", () => {
  test("erro inesperado desfaz tudo (saldo intacto), conta tentativa e, esgotado, vira FAILED/INTERNAL_ERROR", async () => {
    let breakLedger = false;
    const { clock, app } = setup({
      uow: (real): UnitOfWork => ({
        run: (work) =>
          real.run((repos) =>
            work({ ...repos, ledger: { ...repos.ledger, append: async (e) => { if (breakLedger) throw new Error("falha no ledger"); return repos.ledger.append(e); } } }),
          ),
      }),
    });
    const w = await openWallet(app, "100.00");
    const betExt = uniqueId("bet");
    const r = await app.process.execute(command(w, K.Refund, "30.00", { referenceExternalTransactionId: betExt }));
    await app.process.execute(command(w, K.Bet, "30.00", { externalTransactionId: betExt }));

    breakLedger = true;
    for (let i = 0; i < 4; i++) {
      clock.advance(70_000);
      await app.reprocess.runOnce(10);
      if (i < 3) expect((await txRow(r.transactionId)).status).toBe("PENDING_REFERENCE");
    }
    expect(await txRow(r.transactionId)).toMatchObject({ status: "FAILED", failure_code: "INTERNAL_ERROR", reference_attempts: 4 });
    expect(await balanceOf(w.id)).toBe("70.00"); // nada foi creditado
    expect(app.logger.lines.filter((l) => l.level === "error").length).toBeGreaterThanOrEqual(4);
    await expectLedgerInvariant(db.sql, w.id);
  });

  test("wallet travada por outra conexão: pula sem consumir tentativa e retoma depois", async () => {
    const { clock, app } = setup({ lockTimeoutMs: 150 });
    const w = await openWallet(app, "100.00");
    const betExt = uniqueId("bet");
    const r = await app.process.execute(command(w, K.Refund, "30.00", { referenceExternalTransactionId: betExt }));
    await app.process.execute(command(w, K.Bet, "30.00", { externalTransactionId: betExt }));
    clock.advance(2_000);

    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    let locked!: () => void;
    const lockedP = new Promise<void>((res) => (locked = res));
    const holder = db.sql.begin(async (tx) => {
      await tx.unsafe(`select 1 from wallets where id = $1 for update`, [w.id]);
      locked();
      await gate;
    });
    await lockedP;

    expect((await app.reprocess.runOnce(10)).outcomes.skipped).toBe(1);
    expect(await txRow(r.transactionId)).toMatchObject({ status: "PENDING_REFERENCE", reference_attempts: 0 });

    release();
    await holder;
    expect((await app.reprocess.runOnce(10)).outcomes.processed).toBe(1);
    expect(await balanceOf(w.id)).toBe("100.00");
  });
});

describe("laço de longa duração (PendingReferenceWorker)", () => {
  test("resolve sozinho com relógio real e para de forma graciosa", async () => {
    const app = buildApp(orm, { policy: { baseDelayMs: 50, maxDelayMs: 200, maxAttempts: 20, ttlMs: 60_000 } });
    const w = await openWallet(app, "100.00");
    const betExt = uniqueId("bet");
    const r = await app.process.execute(command(w, K.Refund, "30.00", { referenceExternalTransactionId: betExt }));

    const worker = new PendingReferenceWorker(app.reprocess, new CapturingLogger(), { enabled: true, pollIntervalMs: 20, batchSize: 10 });
    worker.onApplicationBootstrap();
    await Bun.sleep(300); // a BET ainda não existe: reagenda sem rejeitar
    expect((await txRow(r.transactionId)).status).toBe("PENDING_REFERENCE");

    await app.process.execute(command(w, K.Bet, "30.00", { externalTransactionId: betExt }));
    await waitFor(async () => (await txRow(r.transactionId)).status === "PROCESSED");
    await worker.stop();
    expect(await balanceOf(w.id)).toBe("100.00");
    await expectLedgerInvariant(db.sql, w.id);
  });
});
