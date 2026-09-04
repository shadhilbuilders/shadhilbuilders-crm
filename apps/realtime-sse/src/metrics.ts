// Metrics — minimal in-process counter / gauge / histogram for the
// standalone SSE service.
//
// T-PERF-2 #4 (2026-09-04). Plain text Prometheus exposition format
// output, no `prom-client` dependency (per user standing rule: no new
// runtime deps without justification). The 5 metrics exposed at
// /api/sse/metrics:
//
//   - realtime_sse_active_connections          (gauge)
//   - realtime_sse_ticket_mint_total          (counter, labels: result)
//   - realtime_sse_ticket_consume_total       (counter, labels: result)
//   - realtime_sse_tick_duration_seconds      (histogram, labels: channel)
//   - realtime_sse_backlog_size               (gauge, labels: channel)
//
// Each counter family is a Map<labelString, number> to keep memory
// bounded (high-cardinality labels would explode). For the current
// use case the label cardinality is bounded:
//   - result ∈ {success, failure, expired, channel_mismatch}
//   - channel ∈ {notifications, audit, chat, ping, healthz, metrics}

type CounterKey = string; // canonicalized label string e.g. `result=success`

export class Metrics {
  private readonly counters = new Map<string, Map<CounterKey, number>>();
  private readonly gauges = new Map<string, Map<CounterKey, number>>();
  private readonly histograms = new Map<string, Map<CounterKey, number[]>>();

  inc(name: string, labels: Record<string, string> = {}, value = 1): void {
    const key = canonicalize(labels);
    let m = this.counters.get(name);
    if (m === undefined) {
      m = new Map();
      this.counters.set(name, m);
    }
    m.set(key, (m.get(key) ?? 0) + value);
  }

  gauge(name: string, labels: Record<string, string> = {}, value: number): void {
    const key = canonicalize(labels);
    let m = this.gauges.get(name);
    if (m === undefined) {
      m = new Map();
      this.gauges.set(name, m);
    }
    m.set(key, value);
  }

  /** Observe a value into a histogram. We keep the raw samples (no
   *  bucketization) for simplicity — the dataset is small per process
   *  and Prometheus' `histogram_quantile()` over raw samples is exact.
   *  For high-cardinality histograms, switch to bucket-based. */
  observe(name: string, labels: Record<string, string> = {}, value: number): void {
    const key = canonicalize(labels);
    let m = this.histograms.get(name);
    if (m === undefined) {
      m = new Map();
      this.histograms.set(name, m);
    }
    const arr = m.get(key) ?? [];
    arr.push(value);
    // Cap to 10k samples per (name, label) to prevent unbounded growth
    // under a misbehaving fetcher.
    if (arr.length > 10_000) arr.shift();
    m.set(key, arr);
  }

  /** Render the metrics in Prometheus text exposition format. */
  render(): string {
    const out: string[] = [];
    for (const [name, series] of this.counters) {
      out.push(`# TYPE ${name} counter`);
      for (const [key, value] of series) out.push(`${name}${labelString(key)} ${value}`);
    }
    for (const [name, series] of this.gauges) {
      out.push(`# TYPE ${name} gauge`);
      for (const [key, value] of series) out.push(`${name}${labelString(key)} ${value}`);
    }
    for (const [name, series] of this.histograms) {
      out.push(`# TYPE ${name} histogram`);
      for (const [key, samples] of series) {
        if (samples.length === 0) continue;
        const sorted = [...samples].sort((a, b) => a - b);
        const sum = samples.reduce((a, b) => a + b, 0);
        const count = samples.length;
        // We expose sum + count, not per-bucket counts (keeps the
        // implementation simple). Prometheus can still compute
        // averages from sum/count; quantiles need bucket-based.
        out.push(`${name}_sum${labelString(key)} ${sum}`);
        out.push(`${name}_count${labelString(key)} ${count}`);
        out.push(`${name}_max${labelString(key)} ${sorted[sorted.length - 1]}`);
        out.push(`${name}_min${labelString(key)} ${sorted[0]}`);
      }
    }
    return out.join('\n') + '\n';
  }
}

/** Canonicalize a label object into a stable string. */
function canonicalize(labels: Record<string, string>): CounterKey {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return '';
  return keys.map((k) => `${k}=${labels[k]}`).join('|');
}

/** Convert a canonicalized label string to the Prometheus exposition
 *  format. Empty string → no label brackets. */
function labelString(canonical: string): string {
  if (canonical === '') return '';
  // Convert `a=1|b=2` → `{a="1",b="2"}`. Escape per spec.
  const parts = canonical.split('|').map((kv) => {
    const [k, v] = kv.split('=', 2);
    const escaped = (v ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
    return `${k}="${escaped}"`;
  });
  return '{' + parts.join(',') + '}';
}

// Module-level singleton so server.ts and the fetchers can share state.
export const metrics = new Metrics();
