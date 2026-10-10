import type { Subprocess } from "bun";

export interface AppProcessConfig {
  port: number;
  databaseUrl: string;
  inputQueue: string;
  dlqQueue: string;
  eventsQueue: string;
}

const endpoint = () => process.env.AWS_ENDPOINT_URL ?? "http://localhost:4566";

/** Um PROCESSO REAL da aplicação (`bun src/main.ts`): mesmo código de produção, módulo raiz completo. */
export class AppProcess {
  private proc?: Subprocess<"ignore", "pipe", "pipe">;
  readonly stdout: string[] = [];
  readonly stderr: string[] = [];

  constructor(readonly config: AppProcessConfig) {}

  get base(): string {
    return `http://127.0.0.1:${this.config.port}`;
  }

  get pid(): number | undefined {
    return this.proc?.pid;
  }

  get alive(): boolean {
    return this.proc !== undefined && this.proc.exitCode === null && this.proc.signalCode === null;
  }

  async start(): Promise<void> {
    const c = this.config;
    this.proc = Bun.spawn(["bun", "src/main.ts"], {
      cwd: process.cwd(),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        PORT: String(c.port),
        DATABASE_URL: c.databaseUrl,
        AWS_REGION: process.env.AWS_REGION ?? "us-east-1",
        AWS_ENDPOINT_URL: endpoint(),
        AWS_ACCESS_KEY_ID: "test",
        AWS_SECRET_ACCESS_KEY: "test",
        SQS_QUEUE_URL: c.inputQueue,
        SQS_DLQ_URL: c.dlqQueue,
        SQS_EVENTS_QUEUE_URL: c.eventsQueue,
        SQS_WAIT_TIME_SECONDS: "1",
        SQS_IDLE_DELAY_MS: "50",
        OUTBOX_POLL_INTERVAL_MS: "100",
        OUTBOX_LEASE_MS: "3000",
        PENDING_REFERENCE_POLL_INTERVAL_MS: "200",
      },
    });
    void pump(this.proc.stdout, this.stdout);
    void pump(this.proc.stderr, this.stderr);
    await this.waitReady();
  }

  private async waitReady(timeoutMs = 30_000): Promise<void> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if (!this.alive) throw new Error(`process exited during startup:\n${this.stdout.join("\n")}\n${this.stderr.join("\n")}`);
      try {
        const res = await fetch(`${this.base}/health/ready`);
        if (res.status === 200) return;
      } catch {
        /* ainda subindo */
      }
      await Bun.sleep(100);
    }
    throw new Error(`process did not become ready:\n${this.stdout.join("\n")}\n${this.stderr.join("\n")}`);
  }

  /** Morte abrupta, sem nenhum hook de encerramento (como um crash/OOM-kill). */
  async kill(): Promise<void> {
    this.proc?.kill("SIGKILL");
    await this.proc?.exited;
  }

  /** SIGTERM e espera sair. Devolve como terminou. */
  async terminate(timeoutMs = 20_000): Promise<{ exitCode: number | null; signalCode: string | null; timedOut: boolean }> {
    if (!this.proc) return { exitCode: null, signalCode: null, timedOut: false };
    this.proc.kill("SIGTERM");
    const result = await Promise.race([this.proc.exited.then(() => "exited" as const), Bun.sleep(timeoutMs).then(() => "timeout" as const)]);
    if (result === "timeout") {
      this.proc.kill("SIGKILL");
      await this.proc.exited;
    }
    return { exitCode: this.proc.exitCode, signalCode: this.proc.signalCode, timedOut: result === "timeout" };
  }
}

async function pump(stream: ReadableStream<Uint8Array>, into: string[]): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let index: number;
    while ((index = buffer.indexOf("\n")) >= 0) {
      into.push(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
    }
  }
  if (buffer) into.push(buffer);
}

/** Pede uma porta livre ao SO (abre em 0 e fecha). Evita colisão com outros processos da máquina. */
export async function freePort(): Promise<number> {
  const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = server.port;
  server.stop(true);
  return port;
}
