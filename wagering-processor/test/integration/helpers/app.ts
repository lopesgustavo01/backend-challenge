import { MikroORM } from "@mikro-orm/postgresql";
import { SystemClock, UuidV7Generator } from "@/infrastructure/system";
import { MikroOrmUnitOfWork } from "@/infrastructure/persistence/postgres/mikro-orm-unit-of-work";
import { UnitOfWork } from "@/modules/wagering/application/ports";
import { PendingReferencePolicy, WagerSettlement } from "@/modules/wagering/application/wager-settlement";
import { ReprocessPendingReferencesUseCase } from "@/modules/wagering/application/reprocess-pending-references.use-case";
import { Clock } from "@/shared/application/ports";
import { InMemoryMetrics } from "@/shared/observability/in-memory-metrics";
import { CapturingLogger } from "./http-server";
import {
  ProcessWagerTransactionCommand,
  ProcessWagerTransactionUseCase,
} from "@/modules/wagering/application/process-wager-transaction.use-case";
import { CreateWalletUseCase } from "@/modules/wallet/application/create-wallet.use-case";
import { WagerTransactionKind } from "@/modules/wagering/domain/wager-transaction";
import { SQL } from "bun";

/** Monta os use cases sobre um ORM real, exatamente como o módulo Nest faz. */
export function buildApp(
  orm: MikroORM,
  options: { uow?: (real: UnitOfWork) => UnitOfWork; lockTimeoutMs?: number; clock?: Clock; policy?: PendingReferencePolicy } = {},
) {
  const clock = options.clock ?? new SystemClock();
  const logger = new CapturingLogger();
  const metrics = new InMemoryMetrics();
  const ids = new UuidV7Generator();
  const real = new MikroOrmUnitOfWork(orm, { lockTimeoutMs: options.lockTimeoutMs });
  const uow = options.uow ? options.uow(real) : real;
  const settlement = new WagerSettlement(clock, ids, options.policy);
  return {
    uow,
    process: new ProcessWagerTransactionUseCase(uow, settlement, clock, ids),
    createWallet: new CreateWalletUseCase(uow, clock, ids),
    reprocess: new ReprocessPendingReferencesUseCase(uow, settlement, clock, logger, metrics),
    logger,
    metrics,
  };
}

export type App = ReturnType<typeof buildApp>;

let counter = 0;
export const uniqueId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(counter++).toString(36)}`;

/** Comando de teste com idempotencyKey/externalId únicos; `overrides` sobrescreve qualquer campo. */
export function command(
  wallet: { id: string; playerId: string },
  kind: WagerTransactionKind,
  amount: string,
  overrides: Partial<ProcessWagerTransactionCommand> = {},
): ProcessWagerTransactionCommand {
  const externalTransactionId = overrides.externalTransactionId ?? uniqueId("ext");
  const providerId = overrides.providerId ?? "provider-a";
  return {
    providerId,
    externalTransactionId,
    idempotencyKey: `${providerId}:${externalTransactionId}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: "round-1",
    gameId: "game-1",
    kind,
    money: { amount, currency: "BRL" },
    ...overrides,
  };
}

export async function openWallet(app: App, balance: string, playerId = uniqueId("player")) {
  const created = await app.createWallet.execute({ playerId, initialBalance: { amount: balance, currency: "BRL" } });
  return { id: created.id, playerId: created.playerId };
}

/** Invariante final de TODOS os testes: wallet.balance == saldo reconstruído pelo ledger (e a cadeia fecha). */
export async function expectLedgerInvariant(sql: SQL, walletId: string): Promise<{ balance: string; version: number }> {
  const [wallet] = await sql.unsafe(`select balance::text as balance, version from wallets where id = $1`, [walletId]);
  const [ledger] = await sql.unsafe(
    `select coalesce(sum(case direction when 'CREDIT' then amount else -amount end), 0)::numeric(19,2)::text as total, count(*)::int as n
       from wallet_ledger_entries where wallet_id = $1`,
    [walletId],
  );
  const [chain] = await sql.unsafe(
    `select count(*)::int as broken from (
       select balance_before, lag(balance_after, 1, 0::numeric) over (order by seq) as prev
         from wallet_ledger_entries where wallet_id = $1) t
      where balance_before <> prev`,
    [walletId],
  );
  if (wallet.balance !== ledger.total) {
    throw new Error(`INVARIANT BROKEN for ${walletId}: balance ${wallet.balance} != ledger ${ledger.total}`);
  }
  if (chain.broken !== 0) throw new Error(`INVARIANT BROKEN for ${walletId}: ledger chain has ${chain.broken} gaps`);
  // version = 1 (criação) + 1 por lançamento, exceto o de abertura, que faz parte da criação
  return { balance: wallet.balance, version: wallet.version };
}

export async function count(sql: SQL, table: string, where = "true", params: unknown[] = []): Promise<number> {
  const [row] = await sql.unsafe(`select count(*)::int as n from ${table} where ${where}`, params);
  return row.n;
}

export async function outboxTypes(sql: SQL, walletId: string): Promise<string[]> {
  const rows = await sql.unsafe(`select event_type from outbox_messages where aggregate_id = $1 order by seq`, [walletId]);
  return rows.map((r: { event_type: string }) => r.event_type);
}
