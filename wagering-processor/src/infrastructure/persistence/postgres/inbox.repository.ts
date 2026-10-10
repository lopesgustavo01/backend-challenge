import { InboxMessage } from "@/shared/messaging/inbox-message";
import { InboxRepository } from "@/modules/wagering/application/ports";
import { Executor, query, toIso } from "./sql";

export class PostgresInboxRepository implements InboxRepository {
  constructor(private readonly em: Executor) {}

  /**
   * Duas entregas simultâneas da mesma mensagem: a segunda BLOQUEIA no índice único até a primeira
   * confirmar e então recebe `false`. Por isso o efeito só é "visto" depois do commit da primeira.
   */
  async tryReceive(message: InboxMessage): Promise<boolean> {
    const rows = await query<{ message_id: string }>(
      this.em,
      `insert into inbox_messages (consumer_name, message_id, payload_hash, received_at)
       values (?, ?, ?, ?)
       on conflict do nothing
       returning message_id`,
      [
        message.consumerName,
        message.messageId,
        message.payloadHash,
        toIso(message.receivedAt),
      ],
    );
    return rows.length === 1;
  }

  async markProcessed(message: InboxMessage): Promise<void> {
    await query(
      this.em,
      `update inbox_messages set processed_at = ? where consumer_name = ? and message_id = ?`,
      [
        message.processedAt ? toIso(message.processedAt) : null,
        message.consumerName,
        message.messageId,
      ],
    );
  }
}
