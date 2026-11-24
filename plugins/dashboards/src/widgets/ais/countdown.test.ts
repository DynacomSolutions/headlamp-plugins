import { describe, expect, it } from 'vitest';
import { COUNTDOWN_PAST, formatCountdown } from './countdown';

const NOW = Date.parse('2026-11-24T10:00:00Z');
const at = (ms: number): string => new Date(NOW + ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe('formatCountdown', () => {
  it('shows days and hours from one day', () => {
    expect(formatCountdown(at(3 * DAY + 4 * HOUR + 30 * MIN), NOW)).toBe('3d 4h');
    expect(formatCountdown(at(DAY), NOW)).toBe('1d');
    expect(formatCountdown(at(6 * DAY + 23 * HOUR + 59 * MIN), NOW)).toBe('6d 23h');
  });

  it('shows hours and minutes under one day', () => {
    expect(formatCountdown(at(5 * HOUR + 12 * MIN + 40_000), NOW)).toBe('5h 12m');
    expect(formatCountdown(at(2 * HOUR), NOW)).toBe('2h');
    expect(formatCountdown(at(DAY - MIN), NOW)).toBe('23h 59m');
  });

  it('shows minutes under one hour', () => {
    expect(formatCountdown(at(12 * MIN), NOW)).toBe('12m');
    expect(formatCountdown(at(HOUR - 1000), NOW)).toBe('59m');
    expect(formatCountdown(at(MIN), NOW)).toBe('1m');
  });

  it('shows <1m under one minute', () => {
    expect(formatCountdown(at(59_000), NOW)).toBe('<1m');
    expect(formatCountdown(at(1), NOW)).toBe('<1m');
  });

  it('shows "now" for a reset that is equal to or before the time now', () => {
    expect(COUNTDOWN_PAST).toBe('now');
    expect(formatCountdown(at(0), NOW)).toBe('now');
    expect(formatCountdown(at(-5 * MIN), NOW)).toBe('now');
    expect(formatCountdown(at(-3 * DAY), NOW)).toBe('now');
    expect(formatCountdown(at(-1), NOW)).not.toMatch(/-/);
  });

  it('shows nothing for a missing or invalid reset', () => {
    expect(formatCountdown(undefined, NOW)).toBe('');
    expect(formatCountdown('', NOW)).toBe('');
    expect(formatCountdown('not a time', NOW)).toBe('');
  });
});
