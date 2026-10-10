import { Metrics } from "@/shared/application/ports";

export interface MetricEntry {
  name: string;
  labels: Record<string, string>;
  value: number;
}

/** Contadores em memória do processo. A exposição (/metrics, formato Prometheus) usa `entries()`. */
export class InMemoryMetrics implements Metrics {
  private readonly counters = new Map<string, MetricEntry>();

  increment(name: string, labels: Record<string, string> = {}, value = 1): void {
    const key = InMemoryMetrics.keyOf(name, labels);
    const current = this.counters.get(key);
    if (current) current.value += value;
    else this.counters.set(key, { name, labels: { ...labels }, value });
  }

  value(name: string, labels: Record<string, string> = {}): number {
    return this.counters.get(InMemoryMetrics.keyOf(name, labels))?.value ?? 0;
  }

  /** Cópia: quem lê não consegue alterar os contadores. */
  entries(): MetricEntry[] {
    return [...this.counters.values()].map((e) => ({ name: e.name, labels: { ...e.labels }, value: e.value }));
  }

  snapshot(): Record<string, number> {
    return Object.fromEntries([...this.counters.entries()].map(([k, e]) => [k, e.value]));
  }

  private static keyOf(name: string, labels: Record<string, string>): string {
    const parts = Object.entries(labels)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`);
    return parts.length === 0 ? name : `${name}{${parts.join(",")}}`;
  }
}
