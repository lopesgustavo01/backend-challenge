import { Global, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { MikroOrmModule } from "@mikro-orm/nestjs";
import { defineConfig } from "@mikro-orm/postgresql";
import { UNIT_OF_WORK_OPTIONS } from "@/infrastructure/persistence/postgres/mikro-orm-unit-of-work";
import { HttpApiModule } from "@/http/http-api.module";
import { InMemoryMetrics } from "@/shared/observability/in-memory-metrics";
import type { AppLogger, LogFields } from "@/shared/application/ports";
import { LOGGER, METRICS } from "@/shared/application/tokens";
import { TestDb } from "./test-db";

export interface LogLine {
  level: "info" | "warn" | "error";
  message: string;
  fields: LogFields | undefined;
}

/** Logger que guarda as linhas para as asserções (o JsonLogger real é só formatação). */
export class CapturingLogger implements AppLogger {
  readonly lines: LogLine[] = [];
  info(message: string, fields?: LogFields) { this.lines.push({ level: "info", message, fields }); }
  warn(message: string, fields?: LogFields) { this.lines.push({ level: "warn", message, fields }); }
  error(message: string, fields?: LogFields) { this.lines.push({ level: "error", message, fields }); }
}

export interface TestServer {
  readonly base: string;
  readonly logger: CapturingLogger;
  readonly metrics: InMemoryMetrics;
  close(): Promise<void>;
}

/** Servidor Nest REAL (porta efêmera) sobre Postgres real; o mesmo HttpApiModule da aplicação. */
export async function startServer(db: TestDb, options: { lockTimeoutMs?: number } = {}): Promise<TestServer> {
  const logger = new CapturingLogger();
  const metrics = new InMemoryMetrics();

  @Global()
  @Module({
    providers: [
      { provide: LOGGER, useValue: logger },
      { provide: METRICS, useValue: metrics },
      { provide: UNIT_OF_WORK_OPTIONS, useValue: { lockTimeoutMs: options.lockTimeoutMs ?? 30_000 } },
    ],
    exports: [LOGGER, METRICS, UNIT_OF_WORK_OPTIONS],
  })
  class TestSupportModule {}

  @Module({
    imports: [
      MikroOrmModule.forRoot(defineConfig({ clientUrl: db.url, entities: [], discovery: { warnWhenNoEntities: false }, pool: { min: 0, max: 25 } })),
      TestSupportModule,
      HttpApiModule,
    ],
  })
  class RootModule {}

  const app = await NestFactory.create(RootModule, { logger: false, abortOnError: false });
  await app.listen(0, "127.0.0.1");
  const address = app.getHttpServer().address() as { port: number };
  return { base: `http://127.0.0.1:${address.port}`, logger, metrics, close: () => app.close() };
}
