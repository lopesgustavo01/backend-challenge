import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { WagerTransactionKind as K, WagerTransactionStatus as S } from "@/modules/wagering/domain/wager-transaction";
import { FailureCode } from "@/modules/wagering/domain/failure-code";
import { IdempotencyConflictError } from "@/modules/wagering/application/errors";
import {
  ProcessWagerTransactionCommand,
  WagerTransactionResult,
} from "@/modules/wagering/application/process-wager-transaction.use-case";
import { App, buildApp, command, count, expectLedgerInvariant, openWallet, outboxTypes, uniqueId } from "../integration/helpers/app";
import { createTestDb, TestDb } from "../integration/helpers/test-db";

// Paralelismo REAL: três "instâncias" da aplicação (cada uma com o seu ORM e o seu pool de conexões, como
// processos separados) disparam ao mesmo tempo contra o mesmo Postgres. Nada de mock, nada de await em sequência.
// Invariante final de todos os testes: wallet.balance == saldo reconstruído pelo ledger.

setDefaultTimeout(60_000);

const INSTANCES = 3;
let db: TestDb;
let apps: App[];
let turn = 0;

beforeAll(async () => {
  db = await createTestDb();
  apps = [];
  // lock_timeout folgado: aqui se mede correção, não o limite de espera (isso é testado à parte)
  for (let i = 0; i < INSTANCES; i++) apps.push(buildApp(await db.newOrm(), { lockTimeoutMs: 30_000 }));
});
afterAll(async () => db.drop());

/** Rodízio entre as instâncias: comandos consecutivos caem em processos diferentes. */
const nextApp = () => apps[turn++ % apps.length]!;

/** Dispara todos os comandos ao mesmo tempo, espalhados entre as instâncias. */
const fire = (commands: ProcessWagerTransactionCommand[]) =>
  Promise.allSettled(commands.map((cmd) => nextApp().process.execute(cmd)));

/** Todos precisam ter resolvido; senão relança o motivo real em vez de esconder atrás de um count errado. */
function values(results: PromiseSettledResult<WagerTransactionResult>[]): WagerTransactionResult[] {
  return results.map((r) => {
    if (r.status === "rejected") throw r.reason;
    return r.value;
  });
}

const debits = (walletId: string) =>
  count(db.sql, "wallet_ledger_entries", "wallet_id = $1 and direction = 'DEBIT'", [walletId]);

describe("múltiplas instâncias: saldo", () => {
  test("cenário obrigatório: 100,00 e duas apostas de 80,00 simultâneas (20 wallets ao mesmo tempo)", async () => {
    const wallets = await Promise.all(Array.from({ length: 20 }, () => openWallet(apps[0]!, "100.00")));
    const outcomes = await Promise.all(
      wallets.map((w) => fire([command(w, K.Bet, "80.00"), command(w, K.Bet, "80.00")])),
    );

    for (const [i, settled] of outcomes.entries()) {
      const w = wallets[i]!;
      const rs = values(settled);
      expect(rs.filter((r) => r.status === S.Processed)).toHaveLength(1);
      const rejected = rs.filter((r) => r.status === S.Rejected);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]!.failureCode).toBe(FailureCode.InsufficientFunds);

      expect(await expectLedgerInvariant(db.sql, w.id)).toEqual({ balance: "20.00", version: 2 });
      expect(await debits(w.id)).toBe(1);
    }
  });

  test("hot wallet: 60 apostas de 10,00 sobre 100,00 => exatamente 10 passam, saldo 0,00, nunca negativo", async () => {
    const w = await openWallet(apps[0]!, "100.00");
    const rs = values(await fire(Array.from({ length: 60 }, () => command(w, K.Bet, "10.00"))));

    expect(rs.filter((r) => r.status === S.Processed)).toHaveLength(10);
    expect(rs.filter((r) => r.status === S.Rejected && r.failureCode === FailureCode.InsufficientFunds)).toHaveLength(50);
    expect(await expectLedgerInvariant(db.sql, w.id)).toEqual({ balance: "0.00", version: 11 });
    expect(await debits(w.id)).toBe(10);
  });

  test("wallets distintas em paralelo não se misturam (12 wallets x 5 apostas de 30,00 sobre 100,00)", async () => {
    const wallets = await Promise.all(Array.from({ length: 12 }, () => openWallet(apps[0]!, "100.00")));
    const commands = wallets.flatMap((w) => Array.from({ length: 5 }, () => command(w, K.Bet, "30.00")));
    values(await fire(commands));

    for (const w of wallets) {
      expect(await expectLedgerInvariant(db.sql, w.id)).toEqual({ balance: "10.00", version: 4 });
      expect(await count(db.sql, "wager_transactions", "wallet_id = $1 and kind = 'BET' and status = 'PROCESSED'", [w.id])).toBe(3);
      expect(await count(db.sql, "wager_transactions", "wallet_id = $1 and kind = 'BET' and status = 'REJECTED'", [w.id])).toBe(2);
    }
  });

  test("carga mista determinística: 150 BET/WIN/LOSS em 5 wallets; saldo bate com o ledger e com as transações", async () => {
    let seed = 20261009;
    const rand = () => {
      // mulberry32: mesma sequência em toda execução
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const initial = 200;
    const amounts = ["5.00", "10.00", "25.00", "40.00", "80.00", "150.00"];
    const wallets = await Promise.all(Array.from({ length: 5 }, () => openWallet(apps[0]!, `${initial}.00`)));

    const commands = Array.from({ length: 150 }, () => {
      const w = wallets[Math.floor(rand() * wallets.length)]!;
      const p = rand();
      const kind = p < 0.6 ? K.Bet : p < 0.85 ? K.Win : K.Loss;
      return command(w, kind, amounts[Math.floor(rand() * amounts.length)]!);
    });
    const rs = values(await fire(commands));
    expect(rs.every((r) => !r.idempotentReplay)).toBe(true);

    let rows = 0;
    for (const w of wallets) {
      const inv = await expectLedgerInvariant(db.sql, w.id);
      expect(Number(inv.balance)).toBeGreaterThanOrEqual(0);

      // cálculo independente, direto das transações PROCESSED (não passa pelo ledger)
      const [{ net }] = await db.sql.unsafe(
        `select coalesce(sum(case kind when 'WIN' then amount when 'BET' then -amount else 0 end), 0)::numeric(19,2)::text as net
           from wager_transactions where wallet_id = $1 and status = 'PROCESSED' and kind <> 'OPENING'`,
        [w.id],
      );
      expect(inv.balance).toBe((initial + Number(net)).toFixed(2));
      rows += await count(db.sql, "wager_transactions", "wallet_id = $1 and kind <> 'OPENING'", [w.id]);
    }
    expect(rows).toBe(150);
  });
});

describe("múltiplas instâncias: idempotência", () => {
  test("a mesma aposta enviada 50 vezes em paralelo => um único débito, 49 replays", async () => {
    const w = await openWallet(apps[0]!, "100.00");
    const cmd = command(w, K.Bet, "25.00");
    const rs = values(await fire(Array.from({ length: 50 }, () => ({ ...cmd }))));

    expect(rs.filter((r) => !r.idempotentReplay)).toHaveLength(1);
    expect(rs.filter((r) => r.idempotentReplay)).toHaveLength(49);
    expect(new Set(rs.map((r) => r.transactionId)).size).toBe(1);
    expect(rs.every((r) => r.status === S.Processed && r.balance?.amount === "75.00")).toBe(true);

    expect(await expectLedgerInvariant(db.sql, w.id)).toEqual({ balance: "75.00", version: 2 });
    expect(await debits(w.id)).toBe(1);
    expect(await count(db.sql, "wager_transactions", "wallet_id = $1 and kind = 'BET'", [w.id])).toBe(1);
    // eventos da aposta saem uma única vez (os 2 primeiros são da abertura)
    expect((await outboxTypes(db.sql, w.id)).slice(2)).toEqual(["WagerTransactionProcessed", "WalletBalanceChanged"]);
  });

  test("mesma key com 10 payloads diferentes: um vence, nove são CONFLITO, um único débito", async () => {
    const w = await openWallet(apps[0]!, "100.00");
    const base = command(w, K.Bet, "1.00");
    const settled = await fire(
      Array.from({ length: 10 }, (_, i) => ({ ...base, money: { amount: `${i + 1}.00`, currency: "BRL" } })),
    );

    const ok = settled.filter((r): r is PromiseFulfilledResult<WagerTransactionResult> => r.status === "fulfilled");
    const bad = settled.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(bad).toHaveLength(9);
    for (const b of bad) expect(b.reason).toBeInstanceOf(IdempotencyConflictError);

    const winner = ok[0]!.value;
    expect(winner.idempotentReplay).toBe(false);
    const inv = await expectLedgerInvariant(db.sql, w.id);
    expect(inv.balance).toBe(winner.balance!.amount);
    expect(await debits(w.id)).toBe(1);
  });

  test("mesma key em wallets diferentes (corrida entre travas distintas): só uma aplica, a outra é conflito e fica intacta", async () => {
    const pairs = await Promise.all(
      Array.from({ length: 10 }, async () => ({
        a: await openWallet(apps[0]!, "100.00"),
        b: await openWallet(apps[1]!, "100.00"),
      })),
    );
    const outcomes = await Promise.all(
      pairs.map(({ a, b }) => {
        const externalTransactionId = uniqueId("shared");
        return fire([
          command(a, K.Bet, "25.00", { externalTransactionId }),
          command(b, K.Bet, "25.00", { externalTransactionId }),
        ]);
      }),
    );

    for (const [i, settled] of outcomes.entries()) {
      const ok = settled.filter((r) => r.status === "fulfilled");
      const bad = settled.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      expect(ok).toHaveLength(1);
      expect(bad).toHaveLength(1);
      expect(bad[0]!.reason).toBeInstanceOf(IdempotencyConflictError);

      const { a, b } = pairs[i]!;
      const balances = [(await expectLedgerInvariant(db.sql, a.id)).balance, (await expectLedgerInvariant(db.sql, b.id)).balance];
      expect(balances.sort()).toEqual(["100.00", "75.00"]);
    }
  });

  test("a mesma mensagem SQS entregue 20 vezes em paralelo => um efeito só, inbox gravado uma vez", async () => {
    const w = await openWallet(apps[0]!, "100.00");
    const messageId = uniqueId("msg");
    const cmd = { ...command(w, K.Bet, "25.00"), inbox: { consumerName: "wager-consumer", messageId } };
    const rs = values(await fire(Array.from({ length: 20 }, () => ({ ...cmd }))));

    expect(rs.filter((r) => !r.idempotentReplay)).toHaveLength(1);
    expect(new Set(rs.map((r) => r.transactionId)).size).toBe(1);
    expect(await expectLedgerInvariant(db.sql, w.id)).toEqual({ balance: "75.00", version: 2 });
    expect(await debits(w.id)).toBe(1);
    expect(await count(db.sql, "inbox_messages", "message_id = $1 and processed_at is not null", [messageId])).toBe(1);
    expect(await count(db.sql, "inbox_messages", "message_id = $1", [messageId])).toBe(1);
  });
});

describe("múltiplas instâncias: reversões", () => {
  test("20 reversões concorrentes da mesma BET (15 REFUND + 5 ROLLBACK, keys distintas) => exatamente uma é aplicada", async () => {
    const w = await openWallet(apps[0]!, "100.00");
    const bet = command(w, K.Bet, "40.00");
    expect((await apps[0]!.process.execute(bet)).status).toBe(S.Processed);

    const reference = { referenceExternalTransactionId: bet.externalTransactionId };
    const rs = values(
      await fire([
        ...Array.from({ length: 15 }, () => command(w, K.Refund, "40.00", reference)),
        ...Array.from({ length: 5 }, () => command(w, K.Rollback, "40.00", reference)),
      ]),
    );

    expect(rs.filter((r) => r.status === S.Processed)).toHaveLength(1);
    const rejected = rs.filter((r) => r.status === S.Rejected);
    expect(rejected).toHaveLength(19);
    expect(rejected.every((r) => r.failureCode === FailureCode.AlreadyReversed)).toBe(true);

    // devolveu uma vez só: 100 - 40 + 40, nunca 140
    expect(await expectLedgerInvariant(db.sql, w.id)).toEqual({ balance: "100.00", version: 3 });
    expect(await count(db.sql, "wager_transactions", "wallet_id = $1 and kind in ('REFUND','ROLLBACK') and status = 'PROCESSED'", [w.id])).toBe(1);
  });
});
