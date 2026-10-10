import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import { WagerTransactionKind as K, WagerTransactionStatus as S } from "@/modules/wagering/domain/wager-transaction";
import { FailureCode } from "@/modules/wagering/domain/failure-code";
import {
  IdempotencyConflictError,
  InvalidCommandError,
  TransientProcessingError,
  WalletAlreadyExistsError,
  WalletMismatchError,
  WalletNotFoundError,
} from "@/modules/wagering/application/errors";
import { UnitOfWork } from "@/modules/wagering/application/ports";
import { App, buildApp, command, count, expectLedgerInvariant, openWallet, outboxTypes, uniqueId } from "./helpers/app";
import { createTestDb, TestDb } from "./helpers/test-db";

let db: TestDb;
let orm: MikroORM;
let app: App;

beforeAll(async () => {
  db = await createTestDb();
  orm = await db.newOrm();
  app = buildApp(orm);
});
afterAll(async () => db.drop());

const rejects = async (promise: Promise<unknown>, type: new (...a: never[]) => Error) => {
  let error: unknown;
  try {
    await promise;
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(type);
  return error as Error;
};

describe("CreateWallet", () => {
  test("saldo > 0: wallet + OPENING + lançamento CREDIT + eventos, na mesma transação", async () => {
    const w = await openWallet(app, "1000.00");
    const inv = await expectLedgerInvariant(db.sql, w.id);
    expect(inv).toEqual({ balance: "1000.00", version: 1 });
    expect(await count(db.sql, "wager_transactions", "wallet_id = $1 and kind = 'OPENING' and status = 'PROCESSED'", [w.id])).toBe(1);
    expect(await count(db.sql, "wallet_ledger_entries", "wallet_id = $1 and direction = 'CREDIT'", [w.id])).toBe(1);
    expect(await outboxTypes(db.sql, w.id)).toEqual(["WagerTransactionProcessed", "WalletBalanceChanged"]);
  });

  test("saldo 0: sem OPENING, sem lançamento, sem eventos", async () => {
    const w = await openWallet(app, "0.00");
    expect(await expectLedgerInvariant(db.sql, w.id)).toEqual({ balance: "0.00", version: 1 });
    expect(await count(db.sql, "wager_transactions", "wallet_id = $1", [w.id])).toBe(0);
    expect(await outboxTypes(db.sql, w.id)).toEqual([]);
  });

  test("segunda wallet do mesmo player e moeda: conflito, e nada é gravado", async () => {
    const playerId = uniqueId("dup");
    await openWallet(app, "10.00", playerId);
    const before = await count(db.sql, "wallets");
    await rejects(openWallet(app, "99.00", playerId), WalletAlreadyExistsError);
    expect(await count(db.sql, "wallets")).toBe(before);
  });

  test("entrada inválida", async () => {
    await rejects(app.createWallet.execute({ playerId: "", initialBalance: { amount: "1.00", currency: "BRL" } }), InvalidCommandError);
    await rejects(app.createWallet.execute({ playerId: "p", initialBalance: { amount: "-1.00", currency: "BRL" } }), InvalidCommandError);
    await rejects(app.createWallet.execute({ playerId: "p", initialBalance: { amount: "1.005", currency: "BRL" } }), InvalidCommandError);
  });
});

describe("BET", () => {
  test("debita, grava ledger e eventos; devolve o saldo", async () => {
    const w = await openWallet(app, "100.00");
    const r = await app.process.execute(command(w, K.Bet, "25.00"));

    expect(r).toMatchObject({ status: S.Processed, balance: { amount: "75.00", currency: "BRL" }, idempotentReplay: false });
    expect(await expectLedgerInvariant(db.sql, w.id)).toEqual({ balance: "75.00", version: 2 });
    expect(await count(db.sql, "wallet_ledger_entries", "wallet_id = $1 and direction = 'DEBIT'", [w.id])).toBe(1);
    expect((await outboxTypes(db.sql, w.id)).slice(2)).toEqual(["WagerTransactionProcessed", "WalletBalanceChanged"]);
  });

  test("saldo insuficiente: REJECTED, sem ledger, saldo e version intactos, só evento Rejected", async () => {
    const w = await openWallet(app, "20.00");
    const r = await app.process.execute(command(w, K.Bet, "80.00"));

    expect(r).toMatchObject({ status: S.Rejected, failureCode: FailureCode.InsufficientFunds, balance: { amount: "20.00" } });
    expect(await expectLedgerInvariant(db.sql, w.id)).toEqual({ balance: "20.00", version: 1 });
    expect(await count(db.sql, "wallet_ledger_entries", "wallet_id = $1 and direction = 'DEBIT'", [w.id])).toBe(0);
    expect((await outboxTypes(db.sql, w.id)).slice(2)).toEqual(["WagerTransactionRejected"]);
  });

  test("pode zerar o saldo exatamente", async () => {
    const w = await openWallet(app, "80.00");
    expect((await app.process.execute(command(w, K.Bet, "80.00"))).status).toBe(S.Processed);
    expect(await expectLedgerInvariant(db.sql, w.id)).toEqual({ balance: "0.00", version: 2 });
  });
});

describe("idempotência", () => {
  test("mesma requisição: replay devolve o resultado ORIGINAL (inclusive o saldo da época)", async () => {
    const w = await openWallet(app, "100.00");
    const cmd = command(w, K.Bet, "25.00");
    const first = await app.process.execute(cmd);
    await app.process.execute(command(w, K.Bet, "10.00")); // saldo muda depois do primeiro
    const replay = await app.process.execute(cmd);

    expect(replay).toEqual({ ...first, idempotentReplay: true });
    expect(replay.balance?.amount).toBe("75.00"); // não 65.00
    expect(await count(db.sql, "wallet_ledger_entries", "wallet_id = $1 and direction = 'DEBIT'", [w.id])).toBe(2);
  });

  test('replay de REJECTED devolve o mesmo status, failureCode e saldo', async () => {
    const w = await openWallet(app, "20.00");
    const cmd = command(w, K.Bet, "80.00");
    const first = await app.process.execute(cmd);
    expect(await app.process.execute(cmd)).toEqual({ ...first, idempotentReplay: true });
    expect((await outboxTypes(db.sql, w.id)).filter((t) => t === "WagerTransactionRejected")).toHaveLength(1);
  });

  test('"25" e "25.00" são o mesmo payload (valor normalizado antes do hash)', async () => {
    const w = await openWallet(app, "100.00");
    const cmd = command(w, K.Bet, "25.00");
    const first = await app.process.execute(cmd);
    const replay = await app.process.execute({ ...cmd, money: { amount: "25", currency: "BRL" } });
    expect(replay.transactionId).toBe(first.transactionId);
    expect(replay.idempotentReplay).toBe(true);
  });

  test("mesma key com payload diferente é CONFLITO, não replay, e não altera nada", async () => {
    const w = await openWallet(app, "100.00");
    const cmd = command(w, K.Bet, "25.00");
    await app.process.execute(cmd);
    await rejects(app.process.execute({ ...cmd, money: { amount: "26.00", currency: "BRL" } }), IdempotencyConflictError);
    await rejects(app.process.execute({ ...cmd, roundId: "round-2" }), IdempotencyConflictError);
    expect(await expectLedgerInvariant(db.sql, w.id)).toEqual({ balance: "75.00", version: 2 });
  });

  test("mesmo (provider, externalId) com outra key é conflito", async () => {
    const w = await openWallet(app, "100.00");
    const cmd = command(w, K.Bet, "25.00");
    await app.process.execute(cmd);
    await rejects(app.process.execute({ ...cmd, idempotencyKey: "outra-key" }), IdempotencyConflictError);
  });
});

describe("WIN e LOSS", () => {
  test("WIN credita; LOSS não move saldo, não gera ledger nem WalletBalanceChanged", async () => {
    const w = await openWallet(app, "100.00");
    await app.process.execute(command(w, K.Bet, "30.00"));
    const win = await app.process.execute(command(w, K.Win, "50.00"));
    expect(win).toMatchObject({ status: S.Processed, balance: { amount: "120.00" } });

    const typesBefore = (await outboxTypes(db.sql, w.id)).length;
    const loss = await app.process.execute(command(w, K.Loss, "0.00"));
    expect(loss).toMatchObject({ status: S.Processed, balance: { amount: "120.00" } });
    expect((await outboxTypes(db.sql, w.id)).slice(typesBefore)).toEqual(["WagerTransactionProcessed"]);
    expect(await expectLedgerInvariant(db.sql, w.id)).toEqual({ balance: "120.00", version: 3 });
  });

  test("WIN vincula a BET quando a referência é válida e segue sem vínculo quando não", async () => {
    const w = await openWallet(app, "100.00");
    const bet = command(w, K.Bet, "10.00");
    const betResult = await app.process.execute(bet);
    const linked = await app.process.execute(command(w, K.Win, "20.00", { referenceExternalTransactionId: bet.externalTransactionId }));
    const unlinked = await app.process.execute(command(w, K.Win, "5.00", { referenceExternalTransactionId: "nao-existe" }));
    expect(unlinked.status).toBe(S.Processed);

    const [row] = await db.sql.unsafe(`select reference_transaction_id from wager_transactions where id = $1`, [linked.transactionId]);
    expect(row.reference_transaction_id).toBe(betResult.transactionId);
    const [row2] = await db.sql.unsafe(`select reference_transaction_id from wager_transactions where id = $1`, [unlinked.transactionId]);
    expect(row2.reference_transaction_id).toBeNull();
  });
});

describe("REFUND e ROLLBACK", () => {
  async function betted(balance = "100.00", amount = "25.00") {
    const w = await openWallet(app, balance);
    const bet = command(w, K.Bet, amount);
    const result = await app.process.execute(bet);
    return { w, bet, result };
  }
  const reversal = (w: { id: string; playerId: string }, kind: K, ref: string, amount: string, o = {}) =>
    command(w, kind, amount, { referenceExternalTransactionId: ref, ...o });

  test("REFUND de BET processada devolve o valor e referencia a BET", async () => {
    const { w, bet, result } = await betted();
    const r = await app.process.execute(reversal(w, K.Refund, bet.externalTransactionId, "25.00"));
    expect(r).toMatchObject({ status: S.Processed, balance: { amount: "100.00" } });
    const [row] = await db.sql.unsafe(`select reference_transaction_id from wager_transactions where id = $1`, [r.transactionId]);
    expect(row.reference_transaction_id).toBe(result.transactionId);
    expect(await expectLedgerInvariant(db.sql, w.id)).toEqual({ balance: "100.00", version: 3 });
  });

  test("segundo REFUND da mesma BET: ALREADY_REVERSED, sem efeito", async () => {
    const { w, bet } = await betted();
    await app.process.execute(reversal(w, K.Refund, bet.externalTransactionId, "25.00"));
    const second = await app.process.execute(reversal(w, K.Refund, bet.externalTransactionId, "25.00"));
    expect(second).toMatchObject({ status: S.Rejected, failureCode: FailureCode.AlreadyReversed, balance: { amount: "100.00" } });
    expect(await expectLedgerInvariant(db.sql, w.id)).toEqual({ balance: "100.00", version: 3 });
  });

  test("REFUND e depois ROLLBACK da MESMA BET: bloqueado (senão creditaria duas vezes)", async () => {
    const { w, bet } = await betted();
    await app.process.execute(reversal(w, K.Refund, bet.externalTransactionId, "25.00"));
    const rb = await app.process.execute(reversal(w, K.Rollback, bet.externalTransactionId, "25.00"));
    expect(rb).toMatchObject({ status: S.Rejected, failureCode: FailureCode.AlreadyReversed });
    expect((await expectLedgerInvariant(db.sql, w.id)).balance).toBe("100.00");
  });

  test("ROLLBACK de um REFUND é outra referência e debita de volta", async () => {
    const { w, bet } = await betted();
    const refund = reversal(w, K.Refund, bet.externalTransactionId, "25.00");
    await app.process.execute(refund);
    const rb = await app.process.execute(reversal(w, K.Rollback, refund.externalTransactionId, "25.00"));
    expect(rb).toMatchObject({ status: S.Processed, balance: { amount: "75.00" } });
    await expectLedgerInvariant(db.sql, w.id);
  });

  test("ROLLBACK de WIN debita; sem saldo é REVERSAL_INSUFFICIENT_FUNDS (código distinto de INSUFFICIENT_FUNDS)", async () => {
    const w = await openWallet(app, "10.00");
    const win = command(w, K.Win, "50.00");
    await app.process.execute(win); // saldo 60
    await app.process.execute(command(w, K.Bet, "55.00")); // saldo 5
    const rb = await app.process.execute(reversal(w, K.Rollback, win.externalTransactionId, "50.00"));
    expect(rb).toMatchObject({ status: S.Rejected, failureCode: FailureCode.ReversalInsufficientFunds, balance: { amount: "5.00" } });
    expect(rb.failureCode).not.toBe(FailureCode.InsufficientFunds);
    expect(await expectLedgerInvariant(db.sql, w.id)).toEqual({ balance: "5.00", version: 3 });
  });

  test.each([
    ["valor diferente", (b: { externalTransactionId: string }) => ({ amount: "10.00", ref: b.externalTransactionId, kind: K.Refund }), FailureCode.AmountMismatch],
    ["outra rodada", (b: { externalTransactionId: string }) => ({ amount: "25.00", ref: b.externalTransactionId, kind: K.Refund, roundId: "round-9" }), FailureCode.ReferenceMismatch],
    ["outro provider", (b: { externalTransactionId: string }) => ({ amount: "25.00", ref: b.externalTransactionId, kind: K.Refund, providerId: "provider-b" }), FailureCode.ReferenceNotFound],
  ])("REFUND com %s", async (_name, build, expected) => {
    const { w, bet } = await betted();
    const { amount, ref, kind, ...rest } = build(bet) as { amount: string; ref: string; kind: K } & Record<string, string>;
    const r = await app.process.execute(reversal(w, kind, ref, amount, rest));
    // "outro provider": a referência não existe naquele provider => fica pendente, não rejeitada
    if (expected === FailureCode.ReferenceNotFound) {
      expect(r.status).toBe(S.PendingReference);
    } else {
      expect(r).toMatchObject({ status: S.Rejected, failureCode: expected });
    }
    expect((await expectLedgerInvariant(db.sql, w.id)).balance).toBe("75.00");
  });

  test("REFUND de um WIN é tipo inválido; REFUND de BET rejeitada é REFERENCE_NOT_PROCESSED", async () => {
    const w = await openWallet(app, "20.00");
    const win = command(w, K.Win, "5.00");
    await app.process.execute(win);
    const bad = await app.process.execute(reversal(w, K.Refund, win.externalTransactionId, "5.00"));
    expect(bad).toMatchObject({ status: S.Rejected, failureCode: FailureCode.InvalidReferenceKind });

    const bigBet = command(w, K.Bet, "500.00");
    expect((await app.process.execute(bigBet)).status).toBe(S.Rejected);
    const onRejected = await app.process.execute(reversal(w, K.Refund, bigBet.externalTransactionId, "500.00"));
    expect(onRejected).toMatchObject({ status: S.Rejected, failureCode: FailureCode.ReferenceNotProcessed });
    expect((await expectLedgerInvariant(db.sql, w.id)).balance).toBe("25.00");
  });

  test("reversão de outra wallet do mesmo provider: REFERENCE_MISMATCH", async () => {
    const { bet } = await betted();
    const other = await openWallet(app, "100.00");
    const r = await app.process.execute(reversal(other, K.Refund, bet.externalTransactionId, "25.00"));
    expect(r).toMatchObject({ status: S.Rejected, failureCode: FailureCode.ReferenceMismatch });
    expect((await expectLedgerInvariant(db.sql, other.id)).balance).toBe("100.00");
  });
});

describe("referência fora de ordem", () => {
  test("REFUND antes da BET fica PENDING_REFERENCE: sem ledger, evento próprio, retry agendado", async () => {
    const w = await openWallet(app, "100.00");
    const r = await app.process.execute(command(w, K.Refund, "25.00", { referenceExternalTransactionId: "bet-que-ainda-nao-chegou" }));

    expect(r).toMatchObject({ status: S.PendingReference, idempotentReplay: false });
    expect(await expectLedgerInvariant(db.sql, w.id)).toEqual({ balance: "100.00", version: 1 });
    expect((await outboxTypes(db.sql, w.id)).slice(2)).toEqual(["WagerTransactionPendingReference"]);

    const [row] = await db.sql.unsafe(
      `select status, reference_attempts, next_attempt_at > now() as in_future from wager_transactions where id = $1`,
      [r.transactionId],
    );
    expect(row).toMatchObject({ status: "PENDING_REFERENCE", reference_attempts: 0, in_future: true });
  });

  test("replay de PENDING_REFERENCE devolve o mesmo estado", async () => {
    const w = await openWallet(app, "100.00");
    const cmd = command(w, K.Rollback, "25.00", { referenceExternalTransactionId: "ainda-nao" });
    const first = await app.process.execute(cmd);
    expect(await app.process.execute(cmd)).toEqual({ ...first, idempotentReplay: true });
  });
});

describe("entradas que nunca viram transação", () => {
  const nothingStored = async (w: { id: string }, run: () => Promise<unknown>, type: new (...a: never[]) => Error) => {
    const txBefore = await count(db.sql, "wager_transactions");
    const outboxBefore = await count(db.sql, "outbox_messages");
    await rejects(run(), type);
    expect(await count(db.sql, "wager_transactions")).toBe(txBefore);
    expect(await count(db.sql, "outbox_messages")).toBe(outboxBefore);
    await expectLedgerInvariant(db.sql, w.id);
  };

  test("wallet inexistente", async () => {
    const w = await openWallet(app, "10.00");
    await nothingStored(w, () => app.process.execute(command({ id: crypto.randomUUID(), playerId: w.playerId }, K.Bet, "1.00")), WalletNotFoundError);
  });

  test("player que não é o dono da wallet", async () => {
    const w = await openWallet(app, "10.00");
    const e = await rejects(app.process.execute(command({ id: w.id, playerId: "intruso" }, K.Bet, "1.00")), WalletMismatchError);
    expect((e as WalletMismatchError).code).toBe("PLAYER_MISMATCH");
  });

  test("moeda diferente da wallet", async () => {
    const w = await openWallet(app, "10.00");
    const e = await rejects(
      app.process.execute(command(w, K.Bet, "1.00", { money: { amount: "1.00", currency: "USD" } })),
      WalletMismatchError,
    );
    expect((e as WalletMismatchError).code).toBe("CURRENCY_MISMATCH");
    await nothingStored(w, () => app.process.execute(command(w, K.Bet, "1.00", { money: { amount: "1.00", currency: "USD" } })), WalletMismatchError);
  });

  test.each([
    ["OPENING é interno", { kind: K.Opening }],
    ["REFUND sem referência", { kind: K.Refund }],
    ["valor com 3 casas", { money: { amount: "1.005", currency: "BRL" } }],
    ["valor negativo", { money: { amount: "-1.00", currency: "BRL" } }],
    ["valor zero em BET", { money: { amount: "0.00", currency: "BRL" } }],
    ["walletId que não é UUID", { walletId: "abc" }],
    ["kind desconhecido", { kind: "FOO" as K }],
    ["providerId vazio", { providerId: "" }],
    ["idempotencyKey vazia", { idempotencyKey: "" }],
  ])("comando inválido: %s", async (_name, overrides) => {
    const w = await openWallet(app, "10.00");
    await nothingStored(w, () => app.process.execute(command(w, K.Bet, "1.00", overrides as never)), InvalidCommandError);
  });
});

describe("inbox (entrada SQS)", () => {
  const inbox = (messageId: string) => ({ consumerName: "wager-consumer", messageId });

  test("primeira entrega processa e marca o inbox; redelivery não duplica efeito", async () => {
    const w = await openWallet(app, "100.00");
    const cmd = { ...command(w, K.Bet, "25.00"), inbox: inbox(uniqueId("msg")) };
    const first = await app.process.execute(cmd);
    const again = await app.process.execute(cmd);

    expect(first.idempotentReplay).toBe(false);
    expect(again).toEqual({ ...first, idempotentReplay: true });
    expect(await expectLedgerInvariant(db.sql, w.id)).toEqual({ balance: "75.00", version: 2 });
    const [row] = await db.sql.unsafe(`select processed_at is not null as done from inbox_messages where message_id = $1`, [cmd.inbox.messageId]);
    expect(row.done).toBe(true);
  });

  test("outro messageId com a mesma idempotency key vira replay (o provedor reenviou)", async () => {
    const w = await openWallet(app, "100.00");
    const base = command(w, K.Bet, "25.00");
    const first = await app.process.execute({ ...base, inbox: inbox(uniqueId("msg")) });
    const second = await app.process.execute({ ...base, inbox: inbox(uniqueId("msg")) });
    expect(second.transactionId).toBe(first.transactionId);
    expect(second.idempotentReplay).toBe(true);
    expect((await expectLedgerInvariant(db.sql, w.id)).balance).toBe("75.00");
  });

  test("erro de negócio desfaz o inbox junto: a mensagem pode ser reprocessada", async () => {
    const w = await openWallet(app, "10.00");
    const messageId = uniqueId("msg");
    await rejects(app.process.execute({ ...command({ id: w.id, playerId: "intruso" }, K.Bet, "1.00"), inbox: inbox(messageId) }), WalletMismatchError);
    expect(await count(db.sql, "inbox_messages", "message_id = $1", [messageId])).toBe(0);
  });
});

describe("atomicidade: tudo ou nada", () => {
  test("falha ao gravar a outbox desfaz transação, saldo, ledger e inbox", async () => {
    const w = await openWallet(app, "100.00");
    const faulty = buildApp(orm, {
      uow: (real): UnitOfWork => ({
        run: (work) =>
          real.run((repos) => work({ ...repos, outbox: { ...repos.outbox, enqueue: async () => { throw new Error("outbox indisponível"); } } })),
      }),
    });
    const cmd = { ...command(w, K.Bet, "25.00"), inbox: { consumerName: "wager-consumer", messageId: uniqueId("msg") } };

    await expect(faulty.process.execute(cmd)).rejects.toThrow("outbox indisponível");

    expect(await count(db.sql, "wager_transactions", "idempotency_key = $1", [cmd.idempotencyKey])).toBe(0);
    expect(await count(db.sql, "inbox_messages", "message_id = $1", [cmd.inbox.messageId])).toBe(0);
    expect(await expectLedgerInvariant(db.sql, w.id)).toEqual({ balance: "100.00", version: 1 });

    // e a mesma requisição, agora com a infraestrutura de volta, é processada normalmente
    expect((await app.process.execute(cmd)).status).toBe(S.Processed);
  });

  test("falha DEPOIS de atualizar o saldo e gravar o ledger também desfaz tudo", async () => {
    const w = await openWallet(app, "100.00");
    const faulty = buildApp(orm, {
      uow: (real): UnitOfWork => ({
        run: (work) =>
          real.run((repos) =>
            work({ ...repos, outbox: { ...repos.outbox, enqueue: async () => { throw new Error("queda após o ledger"); } } }),
          ),
      }),
    });
    await expect(faulty.process.execute(command(w, K.Bet, "40.00"))).rejects.toThrow("queda após o ledger");
    expect(await expectLedgerInvariant(db.sql, w.id)).toEqual({ balance: "100.00", version: 1 });
    expect(await count(db.sql, "wallet_ledger_entries", "wallet_id = $1", [w.id])).toBe(1); // só o de abertura
  });
});

describe("falha transitória de infraestrutura", () => {
  test("lock_timeout vira TransientProcessingError (reenviar é seguro) e nada é gravado", async () => {
    const w = await openWallet(app, "100.00");
    const impatient = buildApp(orm, { lockTimeoutMs: 150 });

    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    const holder = db.sql.begin(async (tx) => {
      await tx.unsafe(`select id from wallets where id = $1 for update`, [w.id]);
      locked();
      await hold;
    });
    await isLocked;

    const cmd = command(w, K.Bet, "10.00");
    await rejects(impatient.process.execute(cmd), TransientProcessingError);
    release();
    await holder;

    expect(await count(db.sql, "wager_transactions", "idempotency_key = $1", [cmd.idempotencyKey])).toBe(0);
    // com o lock liberado, a mesma requisição passa
    expect((await app.process.execute(cmd)).status).toBe(S.Processed);
    await expectLedgerInvariant(db.sql, w.id);
  });
});
