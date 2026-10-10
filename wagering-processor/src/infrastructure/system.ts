import { Clock, IdGenerator } from "@/shared/application/ports";

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

/** UUID v7: monotônico no tempo, bom para índices B-tree das PKs. */
export class UuidV7Generator implements IdGenerator {
  next(): string {
    return Bun.randomUUIDv7();
  }
}
