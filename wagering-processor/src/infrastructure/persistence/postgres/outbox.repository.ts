import { OutboxMessage } from "@/shared/messaging/outbox-message";
import {
  OutboxRepository,
  OutboxStats,
} from "@/modules/wagering/application/ports";
import { Executor, iso, query, toIso } from "./sql";

interface OutboxRow {
  id: string;
  seq: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown> | string;
  attempts: number;
  occurred_at: string;
}

export class PostgresOutboxRepository implements OutboxRepository {
  constructor(private readonly em: Executor) {}

  /** Mesma transação SQL do efeito financeiro: ou os eventos e o saldo confirmam juntos, ou nada. */
  async enqueue(messages: OutboxMessage[]): Promise<void> {
    if (messages.length === 0) return;
    const tuple = "(?, ?, ?, ?::jsonb, ?, ?, ?)";
    await query(
      this.em,
      `insert into outbox_messages (id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at)
       values ${messages.map(() => tuple).join(", ")}`,
      messages.flatMap((m) => [
        m.id,
        m.aggregateId,
        m.eventType,
        JSON.stringify(m.payload),
        toIso(m.occurredAt),
        m.attempts,
        toIso(m.nextAttemptAt ?? m.occurredAt),
      ]),
    );
  }

  async claimDue(
    now: Date,
    limit: number,
    leaseMs: number,
  ): Promise<OutboxMessage[]> {
    const rows = await query<OutboxRow>(
      this.em,
      `with due as (
         select id from outbox_messages
          where published_at is null and next_attempt_at <= ?::timestamptz
          order by next_attempt_at, seq
          limit ?
          for update skip locked)
       update outbox_messages o
          set next_attempt_at = ?::timestamptz
         from due
        where o.id = due.id
       returning o.id, o.seq::text as seq, o.aggregate_id, o.event_type, o.payload, o.attempts,
                 ${iso("o.occurred_at", "occurred_at")}`,
      [toIso(now), limit, toIso(new Date(now.getTime() + leaseMs))],
    );
    return rows
      .sort((a, b) =>
        BigInt(a.seq) < BigInt(b.seq)
          ? -1
          : BigInt(a.seq) > BigInt(b.seq)
            ? 1
            : 0,
      )
      .map((r) =>
        OutboxMessage.rehydrate({
          id: r.id,
          aggregateId: r.aggregate_id,
          eventType: r.event_type,
          payload:
            typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload,
          occurredAt: new Date(r.occurred_at),
          attempts: r.attempts,
        }),
      );
  }

  async markPublished(id: string, at: Date): Promise<boolean> {
    const rows = await query<{ id: string }>(
      this.em,
      `update outbox_messages set published_at = ?::timestamptz, last_error = null
        where id = ? and published_at is null
        returning id`,
      [toIso(at), id],
    );
    return rows.length === 1;
  }

  async saveRetry(message: OutboxMessage, error: string): Promise<void> {
    if (!message.nextAttemptAt)
      throw new Error("saveRetry requires a scheduled retry");
    await query(
      this.em,
      `update outbox_messages set attempts = ?, next_attempt_at = ?::timestamptz, last_error = ?
        where id = ? and published_at is null`,
      [
        message.attempts,
        toIso(message.nextAttemptAt),
        error.slice(0, 1000),
        message.id,
      ],
    );
  }

  async stats(now: Date): Promise<OutboxStats> {
    const [row] = await query<{
      pending: number;
      failing: number;
      age: number;
    }>(
      this.em,
      `select count(*)::int as pending,
              (count(*) filter (where attempts > 0))::int as failing,
              coalesce(extract(epoch from (?::timestamptz - min(occurred_at))), 0)::float8 as age
         from outbox_messages where published_at is null`,
      [toIso(now)],
    );
    return {
      pending: row?.pending ?? 0,
      failing: row?.failing ?? 0,
      oldestPendingAgeSeconds: Math.max(0, Number(row?.age ?? 0)),
    };
  }
}
