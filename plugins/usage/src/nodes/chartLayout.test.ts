import { describe, expect, it, vi } from 'vitest';

vi.mock('@kinvolk/headlamp-plugin/lib', () => ({ ApiProxy: { request: vi.fn() } }));
vi.mock('@iconify/react', () => ({ Icon: () => null }));

import { chartLayout } from './NodeView';

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
    expect(chartLayout(800, 1280)).toEqual({ size: 800, detailBeside: false });
  });

  it('never goes below 200 px', () => {
    expect(chartLayout(0, 768).size).toBe(200);
  });
});
