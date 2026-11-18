/**
 * Prometheus HTTP API client (VictoriaMetrics implements it). Results are kept
 * small for a model: at most a few dozen series, each cut to a few dozen
 * points with the peaks kept, numbers rounded.
 */

export interface Sample {
  metric: Record<string, string>;
  value: number;
  time: string;
}

export interface Series {
  metric: Record<string, string>;
  points: Array<[string, number]>;
  stats: { min: number; max: number; avg: number; first: number; last: number };
}

export const MAX_SERIES = 40;
export const MAX_POINTS = 40;

export class PromClient {
  constructor(private readonly baseUrl: string) {}

  get configured(): boolean {
    return Boolean(this.baseUrl);
  }

  private async call(path: string, params: URLSearchParams): Promise<any> {
    if (!this.baseUrl) throw new Error('No metrics endpoint is configured (METRICS_URL)');
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: params,
      signal: AbortSignal.timeout(30_000),
    });
    const body = (await res.json().catch(() => ({}))) as { status?: string; data?: unknown; error?: string };
    if (!res.ok || body.status !== 'success') throw new Error(`Metrics query failed (${res.status}): ${body.error ?? 'no detail'}`);
    return body.data;
  }

  async query(query: string, time?: Date): Promise<Sample[]> {
    const params = new URLSearchParams({ query });
    if (time) params.set('time', String(time.getTime() / 1000));
    const data = await this.call('/api/v1/query', params);
    if (data.resultType === 'scalar') return [{ metric: {}, value: Number(data.result[1]), time: iso(data.result[0]) }];
    return (data.result as Array<{ metric: Record<string, string>; value: [number, string] }>).map(r => ({
      metric: r.metric,
      value: round(Number(r.value[1])),
      time: iso(r.value[0]),
    }));
  }

  async queryRange(query: string, start: Date, end: Date, stepSeconds?: number): Promise<Series[]> {
    const span = Math.max(60, (end.getTime() - start.getTime()) / 1000);
    const step = stepSeconds ?? Math.max(15, Math.ceil(span / 240));
    const params = new URLSearchParams({
      query,
      start: String(start.getTime() / 1000),
      end: String(end.getTime() / 1000),
      step: `${step}s`,
    });
    const data = await this.call('/api/v1/query_range', params);
    return (data.result as Array<{ metric: Record<string, string>; values: Array<[number, string]> }>).map(r =>
      series(
        r.metric,
        r.values.map(([t, v]) => [t, Number(v)] as [number, number]),
      ),
    );
  }

  async labelValues(label: string, match?: string): Promise<string[]> {
    const params = new URLSearchParams();
    if (match) params.append('match[]', match);
    const data = await this.call(`/api/v1/label/${encodeURIComponent(label)}/values`, params);
    return data as string[];
  }
}

export function round(value: number): number {
  if (!Number.isFinite(value)) return value;
  const abs = Math.abs(value);
  if (abs >= 100) return Math.round(value * 10) / 10;
  if (abs >= 1) return Math.round(value * 1000) / 1000;
  return Number(value.toPrecision(4));
}

function iso(seconds: number): string {
  return new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Cuts a series to MAX_POINTS by keeping the highest value of each bucket, so spikes survive. */
export function series(metric: Record<string, string>, rows: Array<[number, number]>, limit = MAX_POINTS): Series {
  const finite = rows.filter(([, v]) => Number.isFinite(v));
  let kept = finite;
  if (finite.length > limit) {
    const size = Math.ceil(finite.length / limit);
    kept = [];
    for (let i = 0; i < finite.length; i += size) {
      const bucket = finite.slice(i, i + size);
      kept.push(bucket.reduce((best, row) => (row[1] > best[1] ? row : best)));
    }
  }
  const values = finite.map(([, v]) => v);
  const stats =
    values.length === 0
      ? { min: NaN, max: NaN, avg: NaN, first: NaN, last: NaN }
      : {
          min: round(Math.min(...values)),
          max: round(Math.max(...values)),
          avg: round(values.reduce((a, b) => a + b, 0) / values.length),
          first: round(values[0]),
          last: round(values[values.length - 1]),
        };
  return { metric, points: kept.map(([t, v]) => [iso(t), round(v)]), stats };
}

/** "15m", "2h", "1d" or "90s" to seconds. */
export function parseDuration(text: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*(s|m|h|d|w)$/.exec(text.trim());
  if (!m) throw new Error(`Bad duration "${text}"; use forms like 30m, 6h, 2d`);
  const n = Number(m[1]);
  return n * { s: 1, m: 60, h: 3600, d: 86400, w: 604800 }[m[2] as 's' | 'm' | 'h' | 'd' | 'w'];
}
