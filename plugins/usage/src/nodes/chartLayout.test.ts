import { describe, expect, it, vi } from 'vitest';

vi.mock('@kinvolk/headlamp-plugin/lib', () => ({ ApiProxy: { request: vi.fn() } }));
vi.mock('@iconify/react', () => ({ Icon: () => null }));

import { agentAlertText, chartLayout, threadHref } from './NodeView';

describe('chartLayout', () => {
  it('puts CPU and Memory side by side in landscape, half the width each', () => {
    // (1800 - 16) / 2 = 892, under the height limit 1300 - 64.
    expect(chartLayout(1800, 1300)).toEqual({ size: 892, twoUp: true });
  });

  it('keeps the charts within the height under their headings', () => {
    expect(chartLayout(1800, 700)).toEqual({ size: 636, twoUp: true });
  });

  it('has no details column to take width: the width limits when there is height to spare', () => {
    expect(chartLayout(1576, 1000).size).toBe(780);
    expect(chartLayout(1576, 748).size).toBe(684);
  });

  it('puts the charts side by side in portrait when each is 45% of the width or more', () => {
    expect(chartLayout(900, 1400)).toEqual({ size: 442, twoUp: true });
  });

  it('stacks the charts when side by side would be under 45% of the width', () => {
    expect(chartLayout(100, 110).twoUp).toBe(false);
  });

  it('never goes below 200 px, and has no upper limit', () => {
    expect(chartLayout(1000, 200).size).toBe(200);
    expect(chartLayout(6000, 3000).size).toBe(2936);
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
