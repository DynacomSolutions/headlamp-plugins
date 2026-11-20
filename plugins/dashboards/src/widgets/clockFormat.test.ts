import { describe, expect, it } from 'vitest';
import {
  CUSTOM_FORMAT,
  DEFAULT_CLOCK,
  formatClockParts,
  formatPattern,
  isValidZone,
  msToNextTick,
  tickMs,
  timePattern,
  zonedParts,
} from './clockFormat';

// Thursday 19 November 2026, 14:05:09 UTC.
const T = new Date(Date.UTC(2026, 10, 19, 14, 5, 9));
const utc = zonedParts(T, 'UTC');

describe('zonedParts', () => {
  it('reads the parts in a zone', () => {
    expect(utc).toEqual({ year: 2026, month: 11, day: 19, weekday: 4, hour: 14, minute: 5, second: 9 });
    expect(zonedParts(T, 'Asia/Bangkok')).toMatchObject({ day: 19, hour: 21, minute: 5 });
    expect(zonedParts(T, 'Pacific/Auckland')).toMatchObject({ day: 20, hour: 3, weekday: 5 });
  });
  it('shows midnight as 0, not 24', () => {
    expect(zonedParts(new Date(Date.UTC(2026, 0, 1, 0, 0, 0)), 'UTC').hour).toBe(0);
  });
  it('falls back to local time for an unknown zone', () => {
    expect(isValidZone('Nowhere/Land')).toBe(false);
    expect(zonedParts(T, 'Nowhere/Land').year).toBe(T.getFullYear());
  });
});

describe('formatPattern', () => {
  it('formats the date presets', () => {
    expect(formatPattern(utc, 'EEE d MMM yyyy')).toBe('Thu 19 Nov 2026');
    expect(formatPattern(utc, 'EEEE d MMMM yyyy')).toBe('Thursday 19 November 2026');
    expect(formatPattern(utc, 'yyyy-MM-dd')).toBe('2026-11-19');
    expect(formatPattern(utc, 'd/M/yyyy')).toBe('19/11/2026');
    expect(formatPattern(utc, 'dd/MM/yy')).toBe('19/11/26');
  });
  it('pads and uses 12 hours', () => {
    const early = zonedParts(new Date(Date.UTC(2026, 0, 5, 0, 7, 3)), 'UTC');
    expect(formatPattern(early, 'd/M HH:mm:ss')).toBe('5/1 00:07:03');
    expect(formatPattern(early, 'h:mm a')).toBe('12:07 AM');
    expect(formatPattern(utc, 'h:mm a')).toBe('2:05 PM');
    expect(formatPattern(utc, 'hh:mm')).toBe('02:05');
  });
  it('supports quoted text and keeps other characters', () => {
    expect(formatPattern(utc, "'Week' d, MMM")).toBe('Week 19, Nov');
    expect(formatPattern(utc, "d 'o''clock'")).toBe("19 o'clock");
    expect(formatPattern(utc, 'd.M.yyyy · HH')).toBe('19.11.2026 · 14');
  });
});

describe('clock config', () => {
  it('builds the time pattern from the show options', () => {
    expect(timePattern({ showHours: true, showMinutes: true, showSeconds: false, hourFormat: '24' })).toBe('HH:mm');
    expect(timePattern({ showHours: true, showMinutes: true, showSeconds: true, hourFormat: '12' })).toBe('h:mm:ss a');
    expect(timePattern({ showHours: false, showMinutes: true, showSeconds: true, hourFormat: '12' })).toBe('mm:ss');
    expect(timePattern({ showHours: false, showMinutes: false, showSeconds: false, hourFormat: '24' })).toBe('');
  });

  it('formats time and date, hiding what is off', () => {
    const c = { ...DEFAULT_CLOCK, timeZone: 'UTC' };
    expect(formatClockParts(T, c)).toEqual({ time: '14:05', date: 'Thu 19 Nov 2026' });
    expect(formatClockParts(T, { ...c, showSeconds: true, showDate: false })).toEqual({ time: '14:05:09', date: '' });
    expect(formatClockParts(T, { ...c, hourFormat: '12', dateFormat: CUSTOM_FORMAT, customDateFormat: "yyyy 'W' d" })).toEqual({ time: '2:05 PM', date: '2026 W 19' });
    expect(formatClockParts(T, { ...c, showHours: false, showMinutes: false }).time).toBe('');
  });

  it('ticks each second with seconds and each minute without', () => {
    expect(tickMs({ showSeconds: true })).toBe(1000);
    expect(tickMs({ showSeconds: false })).toBe(60000);
    expect(msToNextTick(61_250, 60_000)).toBe(58_750);
    expect(msToNextTick(60_000, 60_000)).toBe(60_000);
  });
});
