import { createHash } from 'node:crypto';
import type { DiagnosisConfig } from './config.js';
import type { Alert } from './agent/report.js';

/**
 * The Alertmanager v2 alert shape that vmalert posts to `-notifier.url`
 * (`POST /api/v2/alerts`, a JSON array). vmalert re-sends firing alerts on
 * every evaluation and sends resolved ones with `endsAt` in the past.
 */
interface PostableAlert {
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  startsAt?: string;
  endsAt?: string;
  generatorURL?: string;
}

export function fingerprint(labels: Record<string, string>): string {
  const sorted = Object.keys(labels)
    .sort()
    .map(k => `${k}=${labels[k]}`)
    .join('\u0000');
  return createHash('sha256').update(sorted).digest('hex').slice(0, 16);
}

export function parseAlerts(body: unknown, now = Date.now()): Array<{ alert: Alert; resolved: boolean }> {
  if (!Array.isArray(body)) throw new Error('Expected a JSON array of alerts');
  return (body as PostableAlert[])
    .filter(a => a && typeof a === 'object' && a.labels?.alertname)
    .map(a => {
      const labels = Object.fromEntries(Object.entries(a.labels ?? {}).map(([k, v]) => [k, String(v)]));
      const annotations = Object.fromEntries(Object.entries(a.annotations ?? {}).map(([k, v]) => [k, String(v)]));
      const endsAt = a.endsAt && !a.endsAt.startsWith('0001-') ? a.endsAt : undefined;
      return {
        alert: {
          name: labels.alertname,
          severity: (labels.severity ?? '').toLowerCase(),
          labels,
          annotations,
          startsAt: a.startsAt ?? '',
          endsAt,
          fingerprint: fingerprint(labels),
          generatorURL: a.generatorURL,
        },
        resolved: endsAt !== undefined && Date.parse(endsAt) <= now,
      };
    });
}

/**
 * Decides which firing alerts start a diagnosis: severity, ignore list, one per activation, an hourly cap.
 * `startedSince` counts diagnoses started since a time from the shared store, so the cap holds across
 * pods and rollouts; without it the gate counts in memory (tests, single process).
 */
export class AlertGate {
  private readonly started: number[] = [];

  constructor(
    private readonly config: DiagnosisConfig,
    private readonly startedSince?: (since: number) => number,
  ) {}

  wants(alert: Alert): { ok: true } | { ok: false; reason: string } {
    if (this.config.ignoreAlerts.includes(alert.name)) return { ok: false, reason: 'ignored alert' };
    if (!this.config.severities.includes(alert.severity)) return { ok: false, reason: `severity "${alert.severity}" is not diagnosed` };
    const hourAgo = Date.now() - 3600_000;
    while (this.started.length && this.started[0] < hourAgo) this.started.shift();
    const count = this.startedSince ? this.startedSince(hourAgo) : this.started.length;
    if (count >= this.config.maxPerHour) return { ok: false, reason: 'hourly diagnosis limit reached' };
    return { ok: true };
  }

  record(): void {
    this.started.push(Date.now());
  }
}

/** A stable UUID-shaped id for one firing alert, so two pods or a repeated POST make the same diagnosis id. */
export function diagnosisIdFor(fingerprint: string, startsAt: string): string {
  const h = createHash('sha256').update(`${fingerprint}|${startsAt}`).digest('hex');
  const variant = ((parseInt(h[16]!, 16) & 3) | 8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
