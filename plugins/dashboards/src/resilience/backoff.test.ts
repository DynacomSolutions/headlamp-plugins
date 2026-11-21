import { describe, expect, it } from 'vitest';
import { backoffDelay } from './backoff';

describe('backoffDelay', () => {
  it('doubles from the base and stops at the cap', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(n => backoffDelay(n, 2_000, 60_000))).toEqual([
      2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000,
    ]);
  });

  it('treats an attempt below 1 as the first and survives a huge attempt count', () => {
    expect(backoffDelay(0)).toBe(2_000);
    expect(backoffDelay(10_000, 2_000, 60_000)).toBe(60_000);
  });

  it('spreads a delay down by at most the jitter share', () => {
    expect(backoffDelay(3, 2_000, 60_000, 0.2, () => 0)).toBe(8_000);
    expect(backoffDelay(3, 2_000, 60_000, 0.2, () => 1)).toBe(6_400);
  });
});
