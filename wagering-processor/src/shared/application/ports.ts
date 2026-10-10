import type { OutboxMessage } from "@/shared/messaging/outbox-message";

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  /** UUID v7: ordenável no tempo, bom para índices. */
  next(): string;
}

export type LogFields = Record<string, unknown>;

/** Log estruturado. Nunca passar payloads financeiros completos nem dados sensíveis: só ids e códigos. */
export interface AppLogger {
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

export interface Metrics {
  increment(name: string, labels?: Record<string, string>, value?: number): void;
}

/**
 * Saída para o broker. Contrato: ao-menos-uma-vez. Deve lançar se não houver certeza de que o broker aceitou;
 * enviar duas vezes a mesma mensagem (mesmo `id`) tem que ser seguro para quem consome.
 */
export interface EventPublisher {
  publish(message: OutboxMessage): Promise<void>;
}
