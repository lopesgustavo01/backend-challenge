import { IntegrationEvent } from "@/shared/messaging/integration-event";
import { InvalidMessageStateError } from "./messaging.errors";

export const OUTBOX_BACKOFF = { baseMs: 1_000, maxMs: 300_000 } as const;

/** Backoff exponencial determinístico: 1s, 2s, 4s, ... até 5 min. `attempts` é a contagem já falha (>= 1). */
export function outboxBackoffMs(attempts: number): number {
  const exponent = Math.max(0, attempts - 1);
  return Math.min(OUTBOX_BACKOFF.baseMs * 2 ** exponent, OUTBOX_BACKOFF.maxMs);
}

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
}

export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt?: Date,
    private _publishedAt?: Date,
  ) {}

  /** O id da mensagem é o eventId: o consumidor deduplica por ele (a publicação é at-least-once). */
  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    return new OutboxMessage(
      event.eventId,
      event.aggregateId,
      event.eventType,
      event.toJSON() as unknown as Record<string, unknown>,
      event.occurredAt,
      0,
      event.occurredAt, // elegível já
    );
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      state.payload,
      state.occurredAt,
      state.attempts,
      state.nextAttemptAt,
      state.publishedAt,
    );
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }

  get publishedAt(): Date | undefined {
    return this._publishedAt;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return this.isPending() && (this._nextAttemptAt === undefined || this._nextAttemptAt.getTime() <= now.getTime());
  }

  markPublished(at: Date): void {
    this.assertPending();
    this._publishedAt = at;
  }

  /** Incrementa attempts e calcula o próximo nextAttemptAt (backoff exponencial). */
  scheduleRetry(now: Date): void {
    this.assertPending();
    this._attempts += 1;
    this._nextAttemptAt = new Date(now.getTime() + outboxBackoffMs(this._attempts));
  }

  private assertPending(): void {
    if (!this.isPending()) {
      throw new InvalidMessageStateError(`Outbox message ${this.id} is already published`);
    }
  }
}
