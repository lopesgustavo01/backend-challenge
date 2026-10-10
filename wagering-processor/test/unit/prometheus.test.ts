import { describe, expect, test } from "bun:test";
import { InMemoryMetrics } from "@/shared/observability/in-memory-metrics";
import { renderPrometheus } from "@/shared/observability/prometheus";

describe("InMemoryMetrics.entries + renderPrometheus", () => {
  test("separa nome e labels, soma incrementos e ordena", () => {
    const m = new InMemoryMetrics();
    m.increment("b_total");
    m.increment("a_total", { y: "2", x: "1" });
    m.increment("a_total", { x: "1", y: "2" }, 4);
    expect(m.entries()).toContainEqual({ name: "a_total", labels: { x: "1", y: "2" }, value: 5 });
    const text = renderPrometheus(m.entries(), []);
    expect(text).toBe('# TYPE a_total counter\na_total{x="1",y="2"} 5\n# TYPE b_total counter\nb_total 1\n');
  });

  test("escapa aspas, barras e quebras de linha nos labels", () => {
    const m = new InMemoryMetrics();
    m.increment("e_total", { v: 'a"b\\c\nd' });
    const text = renderPrometheus(m.entries(), []);
    expect(text).toContain('e_total{v="a\\"b\\\\c\\nd"} 1');
    expect(m.entries()[0]!.labels["v"]).toBeDefined();
  });

  test("gauges levam HELP/TYPE e valores não finitos viram 0", () => {
    const text = renderPrometheus([], [{ name: "g", help: "um gauge", value: Number.NaN }, { name: "h", help: "x", value: 3.5 }]);
    expect(text).toContain("# HELP g um gauge\n# TYPE g gauge\ng 0\n");
    expect(text).toContain("h 3.5");
  });
});
