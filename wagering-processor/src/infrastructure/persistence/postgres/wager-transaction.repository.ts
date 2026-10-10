import { Money } from "@/shared/domain/money";
import { FailureCode } from "@/modules/wagering/domain/failure-code";
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "@/modules/wagering/domain/wager-transaction";
import {
  DuePendingReference,
  PendingReferenceStats,
  StoredWagerTransaction,
  TransactionExtras,
  WagerTransactionRepository,
} from "@/modules/wagering/application/ports";
import { Executor, iso, query, toIso } from "./sql";

interface TransactionRow {
  id: string;
  provider_id: string;
  external_transaction_id: string;
  idempotency_key: string;
  payload_hash: string;
  wallet_id: string;
  player_id: string;
  round_id: string;
  game_id: string;
  kind: string;
  amount: string;
  currency: string;
  reference_external_transaction_id: string | null;
  reference_transaction_id: string | null;
  status: string;
  failure_code: string | null;
  balance_after: string | null;
  reference_attempts: number;
  next_attempt_at: string | null;
  created_at: string;
  processed_at: string | null;
}

const COLUMNS = `id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
  round_id, game_id, kind, amount::text as amount, currency, reference_external_transaction_id,
  reference_transaction_id, status, failure_code, balance_after::text as balance_after, reference_attempts,
  ${iso("next_attempt_at")}, ${iso("created_at")}, ${iso("processed_at")}`;

function toStored(row: TransactionRow): StoredWagerTransaction {
  const transaction = WagerTransaction.rehydrate({
    id: row.id,
    providerId: row.provider_id,
    externalTransactionId: row.external_transaction_id,
    idempotencyKey: row.idempotency_key,
    payloadHash: row.payload_hash,
    walletId: row.wallet_id,
    playerId: row.player_id,
    roundId: row.round_id,
    gameId: row.game_id,
    kind: row.kind as WagerTransactionKind,
    money: Money.from({ amount: row.amount, currency: row.currency }),
    referenceExternalTransactionId:
      row.reference_external_transaction_id ?? undefined,
    createdAt: new Date(row.created_at),
    status: row.status as WagerTransactionStatus,
    referenceTransactionId: row.reference_transaction_id ?? undefined,
    failureCode: (row.failure_code ?? undefined) as FailureCode | undefined,
    processedAt: row.processed_at ? new Date(row.processed_at) : undefined,
  });
  return {
    transaction,
    balanceAfter:
      row.balance_after === null
        ? undefined
        : Money.from({ amount: row.balance_after, currency: row.currency }),
    referenceAttempts: Number(row.reference_attempts),
    nextAttemptAt: row.next_attempt_at
      ? new Date(row.next_attempt_at)
      : undefined,
  };
}

export class PostgresWagerTransactionRepository implements WagerTransactionRepository {
  constructor(private readonly em: Executor) {}

  /**
   * `ON CONFLICT DO NOTHING` sem alvo: cobre idempotency_key E (provider, external id). Quem perde a corrida
   * não recebe exceção (que abortaria a transação), recebe `false` e resolve como replay/conflito.
   */
  async insertIfAbsent(
    t: WagerTransaction,
    extras: TransactionExtras,
  ): Promise<boolean> {
    const rows = await query<{ id: string }>(
      this.em,
      `insert into wager_transactions
         (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
          round_id, game_id, kind, amount, currency, reference_external_transaction_id,
          reference_transaction_id, status, failure_code, balance_after, reference_attempts,
          next_attempt_at, created_at, processed_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict do nothing
       returning id`,
      [
        t.id,
        t.providerId,
        t.externalTransactionId,
        t.idempotencyKey,
        t.payloadHash,
        t.walletId,
        t.playerId,
        t.roundId,
        t.gameId,
        t.kind,
        t.money.toJSON().amount,
        t.money.currency,
        t.referenceExternalTransactionId ?? null,
        t.referenceTransactionId ?? null,
        t.status,
        t.failureCode ?? null,
        extras.balanceAfter?.toJSON().amount ?? null,
        extras.referenceAttempts ?? 0,
        extras.nextAttemptAt ? toIso(extras.nextAttemptAt) : null,
        toIso(t.createdAt),
        t.processedAt ? toIso(t.processedAt) : null,
      ],
    );
    return rows.length === 1;
  }

  /**
   * `balance_after` e `reference_attempts` mantêm o valor atual quando não informados;
   * `next_attempt_at` é sempre substituído (ausente = sem nova tentativa agendada).
   */
  async update(t: WagerTransaction, extras: TransactionExtras): Promise<void> {
    const rows = await query<{ id: string }>(
      this.em,
      `update wager_transactions set
         status = ?, failure_code = ?, reference_transaction_id = ?, processed_at = ?,
         balance_after = coalesce(?::numeric, balance_after),
         reference_attempts = coalesce(?::integer, reference_attempts),
         next_attempt_at = ?
       where id = ?
       returning id`,
      [
        t.status,
        t.failureCode ?? null,
        t.referenceTransactionId ?? null,
        t.processedAt ? toIso(t.processedAt) : null,
        extras.balanceAfter?.toJSON().amount ?? null,
        extras.referenceAttempts ?? null,
        extras.nextAttemptAt ? toIso(extras.nextAttemptAt) : null,
        t.id,
      ],
    );
    if (rows.length !== 1)
      throw new Error(`wager transaction ${t.id} not found for update`);
  }

  async findById(id: string): Promise<StoredWagerTransaction | undefined> {
    return this.findOne(`id = ?`, [id]);
  }

  async findByIdempotencyKey(
    key: string,
  ): Promise<StoredWagerTransaction | undefined> {
    return this.findOne(`idempotency_key = ?`, [key]);
  }

  async findByProviderExternal(
    providerId: string,
    externalTransactionId: string,
  ): Promise<StoredWagerTransaction | undefined> {
    return this.findOne(`provider_id = ? and external_transaction_id = ?`, [
      providerId,
      externalTransactionId,
    ]);
  }

  async findProcessedReversal(
    referenceTransactionId: string,
  ): Promise<WagerTransaction | undefined> {
    const stored = await this.findOne(
      `reference_transaction_id = ? and status = 'PROCESSED' and kind in ('REFUND', 'ROLLBACK')`,
      [referenceTransactionId],
    );
    return stored?.transaction;
  }

  async findDuePendingReference(
    now: Date,
    limit: number,
  ): Promise<DuePendingReference[]> {
    const rows = await query<{ id: string; wallet_id: string }>(
      this.em,
      `select id, wallet_id from wager_transactions
        where status = 'PENDING_REFERENCE' and next_attempt_at <= ?::timestamptz
        order by next_attempt_at, id
        limit ?`,
      [toIso(now), limit],
    );
    return rows.map((r) => ({ id: r.id, walletId: r.wallet_id }));
  }

  async pendingReferenceStats(now: Date): Promise<PendingReferenceStats> {
    const [row] = await query<{ n: number; age: number }>(
      this.em,
      `select count(*)::int as n, coalesce(extract(epoch from (?::timestamptz - min(created_at))), 0)::float8 as age
         from wager_transactions where status = 'PENDING_REFERENCE'`,
      [toIso(now)],
    );
    return {
      count: row?.n ?? 0,
      oldestAgeSeconds: Math.max(0, Number(row?.age ?? 0)),
    };
  }

  private async findOne(
    where: string,
    params: unknown[],
  ): Promise<StoredWagerTransaction | undefined> {
    const [row] = await query<TransactionRow>(
      this.em,
      `select ${COLUMNS} from wager_transactions where ${where} limit 1`,
      params,
    );
    return row ? toStored(row) : undefined;
  }
}
