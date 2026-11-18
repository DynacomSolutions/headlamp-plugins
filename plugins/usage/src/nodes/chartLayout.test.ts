import { describe, expect, it, vi } from 'vitest';

vi.mock('@kinvolk/headlamp-plugin/lib', () => ({ ApiProxy: { request: vi.fn() } }));
vi.mock('@iconify/react', () => ({ Icon: () => null }));

import { agentAlertText, chartLayout, threadHref } from './NodeView';

describe('chartLayout', () => {
  it('puts CPU, Memory and a 360 px details column in one row in landscape', () => {
    // (1800 - 360 - 32) / 2 = 704, under the height limit 1300 - 64.
    expect(chartLayout(1800, 1300)).toEqual({ size: 704, twoUp: true, side: true });
  });

  it('keeps the charts within the height under their headings', () => {
    expect(chartLayout(1800, 700)).toEqual({ size: 636, twoUp: true, side: true });
  });

  it('gives about 590 px at 1600x1000 in kiosk, and 500 px or more in normal mode', () => {
    // Kiosk: the overlay is 1576 wide inside its padding; the height is what is left under
    // the filters bar (72) and the breadcrumb (56).
    expect(chartLayout(1576, 1000 - 24 - 72 - 56).size).toBe(592);
    // Normal mode with a main area 1500 wide (collapsed sidebar), under the app bar, heading,
    // filters bar and breadcrumb.
    expect(chartLayout(1500, 1000 - 64 - 64 - 72 - 56).size).toBeGreaterThanOrEqual(500);
  });

  it('puts the charts side by side in portrait when each is 45% of the width or more', () => {
    expect(chartLayout(900, 1400)).toEqual({ size: 442, twoUp: true, side: false });
  });

  it('stacks the charts when side by side would be under 45% of the width', () => {
    const l = chartLayout(400, 450);
    expect(l.twoUp).toBe(false);
    expect(l.side).toBe(false);
  });

  it('never goes below 200 px or above 1200 px', () => {
    expect(chartLayout(1000, 200).size).toBe(200);
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
