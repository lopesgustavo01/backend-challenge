import type { AppLogger } from "@/shared/application/ports";

/**
 * Laço de polling com parada graciosa: stop() acorda a espera, não inicia nova iteração e AGUARDA a que está
 * em andamento. `iteration` devolve true quando provavelmente há mais trabalho (então não dorme).
 */
export class PollingLoop {
  private stopping = false;
  private loop?: Promise<void>;
  private wake?: () => void;

  constructor(
    private readonly name: string,
    private readonly iteration: () => Promise<boolean>,
    private readonly intervalMs: number,
    private readonly logger: AppLogger,
  ) {}

  get running(): boolean {
    return this.loop !== undefined;
  }

  start(): void {
    if (this.loop) return;
    this.stopping = false;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.wake?.();
    await this.loop;
    this.loop = undefined;
  }

  private async run(): Promise<void> {
    while (!this.stopping) {
      let more = false;
      try {
        more = await this.iteration();
      } catch (error) {
        // banco indisponível etc.: o processo não cai; tenta de novo no próximo ciclo
        this.logger.error(`${this.name} iteration failed`, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (!more && !this.stopping) await this.sleep();
    }
  }

  private sleep(): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.wake = undefined;
        resolve();
      };
      const timer = setTimeout(done, this.intervalMs);
      this.wake = done;
    });
  }
}
