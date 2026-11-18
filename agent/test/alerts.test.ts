import { describe, expect, it } from 'vitest';
import { AlertGate, fingerprint, parseAlerts } from '../src/alerts.js';

describe('vmalert notifier payload', () => {
  const now = Date.parse('2026-11-18T06:00:00Z');
  it('parses firing and resolved alerts', () => {
    const out = parseAlerts(
      [
        { labels: { alertname: 'NodeNotReady', severity: 'critical', node: 'worker-1' }, annotations: { summary: 's' }, startsAt: '2026-11-18T05:50:00Z', endsAt: '2026-11-18T06:10:00Z' },
        { labels: { alertname: 'NodeNotReady', severity: 'critical', node: 'worker-2' }, startsAt: '2026-11-18T05:00:00Z', endsAt: '2026-11-18T05:55:00Z' },
        { labels: {} },
      ],
      now,
    );
    expect(out).toHaveLength(2);
    expect(out[0].resolved).toBe(false);
    expect(out[0].alert.severity).toBe('critical');
    expect(out[1].resolved).toBe(true);
    expect(out[0].alert.fingerprint).toBe(fingerprint({ alertname: 'NodeNotReady', severity: 'critical', node: 'worker-1' }));
  });
  it('fingerprints ignore label order', () => {
    expect(fingerprint({ a: '1', b: '2' })).toBe(fingerprint({ b: '2', a: '1' }));
  });
  it('gates by severity, ignore list and hourly cap', () => {
    const gate = new AlertGate({ toolBudget: 5, severities: ['critical'], maxPerHour: 1, ignoreAlerts: ['Watchdog'] });
    const alert = { name: 'X', severity: 'critical', labels: {}, annotations: {}, startsAt: '', fingerprint: 'f' };
    expect(gate.wants({ ...alert, severity: 'info' }).ok).toBe(false);
    expect(gate.wants({ ...alert, name: 'Watchdog' }).ok).toBe(false);
    expect(gate.wants(alert).ok).toBe(true);
    gate.record();
    expect(gate.wants(alert)).toEqual({ ok: false, reason: 'hourly diagnosis limit reached' });
  });
});
