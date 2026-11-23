import { describe, expect, it } from 'vitest';
import {
  axisTicks,
  bucketSpan,
  clockLabel,
  dayLabel,
  formatSpan,
  tickStepFor,
  zoneName,
} from './timeAxis';

const BANGKOK = 'Asia/Bangkok';
const LONDON = 'Europe/London';
// Mon 23 Nov 2026 12:00:00 UTC (19:00 in Bangkok, 12:00 in London).
const NOON = Date.UTC(2026, 10, 23, 12, 0, 0) / 1000;
const grid24h = { startSec: NOON, stepSec: 900, buckets: 96 };

describe('tick step', () => {
  it('uses hours for a day and days for a week or more', () => {
    expect(tickStepFor(86400, 900, 12)).toBe(7200);
    expect(tickStepFor(6 * 3600, 300, 12)).toBe(1800);
    expect(tickStepFor(3600, 60, 12)).toBe(300);
    expect(tickStepFor(3600, 60, 6)).toBe(600);
    expect(tickStepFor(7 * 86400, 7200, 12)).toBe(86400);
    expect(tickStepFor(30 * 86400, 28800, 12)).toBe(3 * 86400);
  });
  it('never goes under one cell, and gives fewer ticks in a narrow strip', () => {
    expect(tickStepFor(86400, 7200, 100)).toBe(7200);
    expect(tickStepFor(86400, 900, 4)).toBe(21600);
    expect(tickStepFor(86400, 900, 0)).toBe(86400);
  });
});

describe('axis ticks', () => {
  it('puts a tick on every 2 hours of local time for a day and marks the midnight with the day', () => {
    const ticks = axisTicks(grid24h, { timeZone: BANGKOK, maxTicks: 12 });
    const labels = ticks.map(t => t.label);
    // Bucket 0 is 19:00 Bangkok time on Mon 23 Nov, and the 96 cells run 24 h from there to 19:00 on Tue 24.
    expect(labels).toEqual([
      '20:00',
      '22:00',
      'Tue 24',
      '02:00',
      '04:00',
      '06:00',
      '08:00',
      '10:00',
      '12:00',
      '14:00',
      '16:00',
      '18:00',
    ]);
    expect(ticks.filter(t => t.day).map(t => t.label)).toEqual(['Tue 24']);
  });

  it('sits each tick on the left edge of a cell that the local time falls in', () => {
    const ticks = axisTicks(grid24h, { timeZone: BANGKOK, maxTicks: 12 });
    const first = grid24h.startSec - grid24h.stepSec;
    for (const t of ticks) {
      const edge = first + t.index * grid24h.stepSec;
      // The aligned time is at the edge or before it by less than one cell (here: exactly on it).
      expect(clockLabel(edge, BANGKOK)).toMatch(/^\d\d:00$/);
      expect(Number(clockLabel(edge, BANGKOK).slice(0, 2)) % 2).toBe(0);
    }
    expect(new Set(ticks.map(t => t.index)).size).toBe(ticks.length);
    expect(ticks.every(t => t.index >= 0 && t.index < grid24h.buckets)).toBe(true);
  });

  it('follows the zone: the same grid has different labels in London', () => {
    const labels = axisTicks(grid24h, { timeZone: LONDON, maxTicks: 12 }).map(t => t.label);
    // Bucket 0 is noon in London, so the cells end at noon on Tue 24.
    expect(labels).toContain('Tue 24');
    expect(labels).toContain('14:00');
    expect(labels).not.toEqual(axisTicks(grid24h, { timeZone: BANGKOK }).map(t => t.label));
  });

  it('gives fewer ticks for a narrow strip', () => {
    const narrow = axisTicks(grid24h, { timeZone: BANGKOK, maxTicks: 4 });
    expect(narrow.length).toBeLessThanOrEqual(5);
    expect(narrow.length).toBeGreaterThan(1);
  });

  it('shows days only for a week, each tick a day boundary', () => {
    const week = axisTicks({ startSec: NOON, stepSec: 7200, buckets: 84 }, { timeZone: LONDON });
    expect(week.length).toBeGreaterThanOrEqual(7);
    expect(week.every(t => t.day)).toBe(true);
    expect(week.map(t => t.label)).toContain('Tue 24');
    expect(week.map(t => t.label)).toContain('Mon 30');
    expect(week.every(t => /^[A-Z][a-z]{2} \d{1,2}$|^1 [A-Z][a-z]{2}$/.test(t.label))).toBe(true);
  });

  it('names the first day of a month with its month', () => {
    const start = Date.UTC(2026, 10, 28, 12) / 1000; // Sat 28 Nov, the week ends on Sat 5 Dec
    const labels = axisTicks(
      { startSec: start, stepSec: 7200, buckets: 84 },
      { timeZone: LONDON }
    ).map(t => t.label);
    expect(labels).toContain('1 Dec');
  });

  it('uses 5 minute ticks for an hour and marks the midnight London time', () => {
    const hour = axisTicks(
      { startSec: Date.UTC(2026, 10, 22, 23, 20) / 1000, stepSec: 60, buckets: 60 },
      { timeZone: LONDON }
    );
    expect(hour.map(t => t.label)).toEqual([
      '23:20',
      '23:25',
      '23:30',
      '23:35',
      '23:40',
      '23:45',
      '23:50',
      '23:55',
      'Mon 23',
      '00:05',
      '00:10',
      '00:15',
    ]);
    expect(hour.filter(t => t.day).length).toBe(1);
    expect(
      axisTicks(
        { startSec: Date.UTC(2026, 10, 22, 23, 20) / 1000, stepSec: 60, buckets: 60 },
        { timeZone: LONDON, maxTicks: 6 }
      ).map(t => t.label)
    ).toEqual(['23:20', '23:30', '23:40', '23:50', 'Mon 23', '00:10']);
  });

  it('handles a clock change: one midnight tick, each cell used once, in order', () => {
    // London moves to summer time at 01:00 UTC on Sun 29 Mar 2026. The span starts at noon on Sat 28 Mar.
    const start = Date.UTC(2026, 2, 28, 12) / 1000;
    const ticks = axisTicks({ startSec: start, stepSec: 900, buckets: 96 }, { timeZone: LONDON });
    expect(ticks.filter(t => t.day).map(t => t.label)).toEqual(['Sun 29']);
    const indexes = ticks.map(t => t.index);
    expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
    expect(new Set(indexes).size).toBe(indexes.length);
  });

  it('is empty for an empty grid', () => {
    expect(axisTicks({ startSec: NOON, stepSec: 900, buckets: 0 })).toEqual([]);
  });
});

describe('bucket spans', () => {
  it('starts one step before the point and ends at it', () => {
    expect(bucketSpan({ startSec: 1000, stepSec: 60 }, 0)).toEqual({ fromSec: 940, toSec: 1000 });
    expect(bucketSpan({ startSec: 1000, stepSec: 60 }, 3)).toEqual({ fromSec: 1120, toSec: 1180 });
  });
  it('writes the exact start and end in the zone', () => {
    const { fromSec, toSec } = bucketSpan({ startSec: NOON, stepSec: 900 }, 0);
    expect(formatSpan(fromSec, toSec, LONDON)).toBe('Mon 23 Nov 11:45 to 12:00');
    expect(formatSpan(fromSec, toSec, BANGKOK)).toBe('Mon 23 Nov 18:45 to 19:00');
  });
  it('shows both days when a cell crosses midnight', () => {
    const mid = Date.UTC(2026, 10, 23, 0, 0) / 1000;
    expect(formatSpan(mid - 3600, mid + 3600, LONDON)).toBe('Sun 22 Nov 23:00 to Mon 23 Nov 01:00');
  });
});

describe('labels', () => {
  it('formats a clock and a day in the zone', () => {
    expect(clockLabel(NOON, BANGKOK)).toBe('19:00');
    expect(dayLabel(NOON, BANGKOK)).toBe('Mon 23');
    expect(zoneName(NOON, BANGKOK)).toMatch(/GMT\+7|UTC\+7/);
  });
});
