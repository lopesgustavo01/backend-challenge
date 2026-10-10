import { MetricEntry } from "./in-memory-metrics";

export interface GaugeEntry {
  name: string;
  help: string;
  value: number;
  labels?: Record<string, string>;
}

const escapeLabel = (v: string) => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");

function line(name: string, labels: Record<string, string>, value: number): string {
  const parts = Object.entries(labels)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}="${escapeLabel(v)}"`);
  return `${name}${parts.length > 0 ? `{${parts.join(",")}}` : ""} ${Number.isFinite(value) ? value : 0}`;
}

/** Formato de texto do Prometheus (exposition format 0.0.4). Contadores do processo + gauges lidos do banco. */
export function renderPrometheus(counters: MetricEntry[], gauges: GaugeEntry[]): string {
  const out: string[] = [];
  const byName = new Map<string, MetricEntry[]>();
  for (const c of counters) byName.set(c.name, [...(byName.get(c.name) ?? []), c]);
  for (const [name, entries] of [...byName.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    out.push(`# TYPE ${name} counter`);
    for (const e of entries) out.push(line(name, e.labels, e.value));
  }
  for (const g of gauges) {
    out.push(`# HELP ${g.name} ${g.help}`, `# TYPE ${g.name} gauge`, line(g.name, g.labels ?? {}, g.value));
  }
  return out.join("\n") + "\n";
}
