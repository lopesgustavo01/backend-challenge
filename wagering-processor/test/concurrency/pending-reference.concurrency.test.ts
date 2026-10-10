import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import { WagerTransactionKind as K, WagerTransactionStatus as S } from "@/modules/wagering/domain/wager-transaction";
import { buildApp, command, expectLedgerInvariant, openWallet, uniqueId } from "../integration/helpers/app";
import { FakeClock } from "../integration/helpers/sqs";
import { createTestDb, TestDb } from "../integration/helpers/test-db";

// Três "instâncias" do worker (ORM e pool próprios) varrendo ao mesmo tempo as MESMAS transações pendentes,
// enquanto novas apostas e reversões continuam chegando nas mesmas wallets.
setDefaultTimeout(120_000);

let db: TestDb;
let orms: MikroORM[];
beforeAll(async () => {
  db = await createTestDb();
  orms = [await db.newOrm(), await db.newOrm(), await db.newOrm()];
});
afterAll(async () => db.drop());

describe("workers de PENDING_REFERENCE concorrentes", () => {
  test("60 REFUNDs pendentes em 6 wallets + tráfego novo: cada um é aplicado exatamente uma vez, saldos exatos", async () => {
    const clock = new FakeClock();
    const policy = { baseDelayMs: 1_000, maxDelayMs: 10_000, maxAttempts: 8, ttlMs: 10 * 60_000 };
    const apps = orms.map((orm) => buildApp(orm, { clock, policy, lockTimeoutMs: 30_000 }));
    const wallets: Array<{ id: string; playerId: string }> = [];
    for (let i = 0; i < 6; i++) wallets.push(await openWallet(apps[0]!, "1000.00"));

    // reversões chegam ANTES das apostas
    const pairs: Array<{ w: { id: string; playerId: string }; betExt: string; refundId: string }> = [];
    for (let i = 0; i < 60; i++) {
      const w = wallets[i % 6]!;
      const betExt = uniqueId("bet");
      const refund = await apps[i % 3]!.process.execute(command(w, K.Refund, "10.00", { referenceExternalTransactionId: betExt }));
      expect(refund.status).toBe(S.PendingReference);
      pairs.push({ w, betExt, refundId: refund.transactionId });
    }
    for (const p of pairs) await apps[0]!.process.execute(command(p.w, K.Bet, "10.00", { externalTransactionId: p.betExt }));
    expect(await balance(wallets[0]!.id)).not.toBe("1000.00");

    clock.advance(1_000);
    const extraTraffic = Promise.all(
      Array.from({ length: 30 }, (_, i) => apps[i % 3]!.process.execute(command(wallets[i % 6]!, K.Bet, "1.00"))),
    );
    const sweeps = Promise.all(
      apps.map(async (app) => {
        for (let i = 0; i < 20; i++) {
          if ((await app.reprocess.runOnce(15)).due === 0) break;
        }
      }),
    );
    await Promise.all([extraTraffic, sweeps]);

    // concorrência resolvida pelo lock + releitura, não por exceção: nenhum erro foi logado em nenhum worker
    expect(apps.flatMap((a) => a.logger.lines.filter((l) => l.level === "error"))).toEqual([]);
    expect(apps.reduce((n, a) => n + a.metrics.value("pending_reference_total", { outcome: "failed" }), 0)).toBe(0);

    const [{ pending }] = await db.sql.unsafe(`select count(*)::int as pending from wager_transactions where status = 'PENDING_REFERENCE'`);
    expect(pending).toBe(0);
    const [{ processed }] = await db.sql.unsafe(`select count(*)::int as processed from wager_transactions where kind = 'REFUND' and status = 'PROCESSED'`);
    expect(processed).toBe(60);
    for (const w of wallets) {
      // 10 REFUNDs de 10 e 10 BETs de 10 se anulam; sobram 5 apostas extras de 1.00 por wallet
      expect(await balance(w.id)).toBe("995.00");
      await expectLedgerInvariant(db.sql, w.id);
    }
    const [{ dup }] = await db.sql.unsafe(
      `select count(*)::int as dup from (select reference_transaction_id from wager_transactions where kind = 'REFUND' and status = 'PROCESSED' group by 1 having count(*) > 1) t`,
    );
    expect(dup).toBe(0);
  });
});

const balance = async (id: string) => (await db.sql.unsafe(`select balance::text as b from wallets where id = $1`, [id]))[0].b as string;
