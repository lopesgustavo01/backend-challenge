import { AppLogger, LogFields } from "@/shared/application/ports";

type Level = "info" | "warn" | "error";

/**
 * Log estruturado: uma linha JSON por evento, em stdout (stderr para erros).
 * Regra: nunca logar payloads financeiros completos nem dados sensíveis; só ids e códigos.
 */
export class JsonLogger implements AppLogger {
  info(message: string, fields?: LogFields): void {
    this.write("info", message, fields);
  }

  warn(message: string, fields?: LogFields): void {
    this.write("warn", message, fields);
  }

  error(message: string, fields?: LogFields): void {
    this.write("error", message, fields);
  }

  private write(level: Level, message: string, fields: LogFields = {}): void {
    const line = JSON.stringify({ level, time: new Date().toISOString(), message, ...fields });
    (level === "error" ? process.stderr : process.stdout).write(`${line}\n`);
  }
}
