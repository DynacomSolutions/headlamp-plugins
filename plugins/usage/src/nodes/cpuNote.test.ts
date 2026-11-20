import { describe, expect, it } from 'vitest';
import { cpuNote } from './cpuNote';

describe('cpuNote', () => {
  it('has no note for a backend without CPU limits', () => {
    expect(cpuNote({})).toBeUndefined();
  });
  it('names the limit and the throttling', () => {
    expect(cpuNote({ cpuLimitCores: 16, cpuThrottledRatio: 0.125 })).toBe(
      'CPU limit 16 cores, throttled 13%'
    );
    expect(cpuNote({ cpuLimitCores: 1, cpuThrottledRatio: 0.034 })).toBe(
      'CPU limit 1 core, throttled 3.4%'
    );
    expect(cpuNote({ cpuLimitCores: 8, cpuThrottledRatio: 0 })).toBe(
      'CPU limit 8 cores, throttled 0%'
    );
  });
  it('says so when there is no limit', () => {
    expect(cpuNote({ cpuLimitCores: null })).toBe('No CPU limit');
    expect(cpuNote({ cpuLimitCores: null, cpuThrottledRatio: 0 })).toBe(
      'No CPU limit, throttled 0%'
    );
  });
});
