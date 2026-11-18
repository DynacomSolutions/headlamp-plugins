import { describe, expect, it, vi } from 'vitest';

vi.mock('@kinvolk/headlamp-plugin/lib', () => ({ ApiProxy: { request: vi.fn() } }));
vi.mock('@iconify/react', () => ({ Icon: () => null }));

import { agentAlertText, chartLayout, threadHref } from './NodeView';

describe('chartLayout', () => {
  it('gives both charts the full width side by side on a wide landscape screen', () => {
    // (1800 - 16) / 2 = 892, under the height limit 1300 - 64.
    expect(chartLayout(1800, 1300)).toEqual({ size: 892, twoUp: true });
  });

  it('keeps side-by-side charts within the screen height', () => {
    // 800 - 64 = 736, under the width share 892.
    expect(chartLayout(1800, 800)).toEqual({ size: 736, twoUp: true });
    expect(chartLayout(1800, 600).size).toBe(536);
  });

  it('stacks the charts full width in portrait', () => {
    expect(chartLayout(800, 2000)).toEqual({ size: 800, twoUp: false });
  });

  it('caps stacked charts so both fit the screen height', () => {
    // (1280 - 2 * 64 - 16) / 2 = 568, under the width 800.
    expect(chartLayout(800, 1280)).toEqual({ size: 568, twoUp: false });
  });

  it('never goes below 200 px or above 1200 px', () => {
    expect(chartLayout(0, 768).size).toBe(200);
    expect(chartLayout(4000, 3000).size).toBe(1200);
  });
});

describe('threadHref', () => {
  it('keeps only http(s) links', () => {
    expect(threadHref('https://example.com/t/1')).toBe('https://example.com/t/1');
    expect(threadHref('http://example.com/t/1')).toBe('http://example.com/t/1');
    expect(threadHref('javascript:alert(1)')).toBeUndefined();
    expect(threadHref(undefined)).toBeUndefined();
  });
});

describe('agentAlertText', () => {
  it('names the time of stale agent data', () => {
    const at = new Date(2026, 0, 1, 9, 30, 0).getTime();
    expect(agentAlertText('boom', at)).toContain(
      `agent data from ${new Date(at).toLocaleTimeString()}`
    );
    expect(agentAlertText('boom')).toBe('Agent detail unavailable: boom');
  });
});
