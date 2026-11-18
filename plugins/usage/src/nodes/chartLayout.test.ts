import { describe, expect, it, vi } from 'vitest';

vi.mock('@kinvolk/headlamp-plugin/lib', () => ({ ApiProxy: { request: vi.fn() } }));
vi.mock('@iconify/react', () => ({ Icon: () => null }));

import { agentAlertText, chartLayout } from './NodeView';

describe('chartLayout', () => {
  it('puts both charts and the detail panel side by side on a wide landscape screen', () => {
    const l = chartLayout(1800, 1080);
    expect(l.detailBeside).toBe(true);
    // (1800 - 380 - 16 - 16) / 2 = 694, under the height limit 1080 - 220.
    expect(l.size).toBe(694);
  });

  it('keeps side-by-side charts within the screen height', () => {
    expect(chartLayout(1800, 600).size).toBe(380);
  });

  it('stacks the charts full width in portrait', () => {
    expect(chartLayout(800, 2000)).toEqual({ size: 800, detailBeside: false });
  });

  it('caps stacked charts so both fit the screen height', () => {
    // (1280 - 220) / 2 = 530, under the width 800.
    expect(chartLayout(800, 1280)).toEqual({ size: 530, detailBeside: false });
  });

  it('never goes below 200 px', () => {
    expect(chartLayout(0, 768).size).toBe(200);
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
