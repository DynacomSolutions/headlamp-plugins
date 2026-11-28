import { describe, expect, it, vi } from 'vitest';

vi.mock('@kinvolk/headlamp-plugin/lib', () => ({ ApiProxy: { request: vi.fn() } }));
vi.mock('@iconify/react', () => ({ Icon: () => null }));

import { formatCores } from '../units';
import { figures } from './DetailPanel';
import { agentAlertText, chartLayout, threadHref, usedText } from './NodeView';
import type { NodeTree } from './tree';

describe('chartLayout', () => {
  it('puts CPU and Memory side by side in landscape, half the width each', () => {
    // (1800 - 16) / 2 = 892, under the height limit 1300 - 80.
    expect(chartLayout(1800, 1300)).toEqual({ size: 892, twoUp: true });
  });

  it('keeps the charts within the height under their headings', () => {
    expect(chartLayout(1800, 700)).toEqual({ size: 620, twoUp: true });
  });

  it('has no details column to take width: the width limits when there is height to spare', () => {
    expect(chartLayout(1576, 1000).size).toBe(780);
    expect(chartLayout(1576, 748).size).toBe(668);
  });

  it('puts the charts side by side in portrait when each is 45% of the width or more', () => {
    expect(chartLayout(900, 1400)).toEqual({ size: 442, twoUp: true });
  });

  it('stacks the charts when side by side would be under 45% of the width', () => {
    expect(chartLayout(100, 110).twoUp).toBe(false);
  });

  it('lets a widget pick the layout with the bigger charts', () => {
    // Wide and short: side by side.
    expect(chartLayout(1200, 500, false, false, true)).toEqual({ size: 420, twoUp: true });
    // Narrow and tall: stacked at 362, instead of two charts at 252.
    expect(chartLayout(520, 900, false, false, true)).toEqual({ size: 362, twoUp: false });
    // The page rule would have chosen side by side at 252 here.
    expect(chartLayout(520, 900).twoUp).toBe(true);
    // Never under the minimum chart size.
    expect(chartLayout(100, 100, false, false, true).size).toBe(200);
  });

  it('stacks full width charts on a phone in portrait', () => {
    expect(chartLayout(390, 700, true, true)).toEqual({ size: 390, twoUp: false });
    // The page scrolls, so a short room does not shrink them.
    expect(chartLayout(390, 250, true, true)).toEqual({ size: 390, twoUp: false });
  });

  it('puts the charts side by side on a phone in landscape, whatever the height', () => {
    expect(chartLayout(844, 250, true, false)).toEqual({ size: 414, twoUp: true });
    expect(chartLayout(844, 250, true)).toEqual({ size: 414, twoUp: true });
  });

  it('leaves the desktop layout alone when it is not a phone', () => {
    expect(chartLayout(390, 700, false, true)).toEqual(chartLayout(390, 700));
    expect(chartLayout(1800, 700, false, false)).toEqual({ size: 620, twoUp: true });
  });

  it('never goes below 200 px, and has no upper limit', () => {
    expect(chartLayout(1000, 200).size).toBe(200);
    expect(chartLayout(6000, 3000).size).toBe(2920);
  });
});

const tree: NodeTree = {
  root: {
    key: 'root',
    label: 'root',
    value: 4,
    kind: 'category',
    children: [
      { key: 'sys', label: 'sys', displayName: 'System', value: 3, kind: 'system', children: [] },
    ],
  },
  capacity: 8,
  used: 4,
  hostMetrics: true,
};

describe('usedText', () => {
  it('shows used against capacity at the root', () => {
    expect(usedText(tree, 'cpu')).toBe('4.00 cores of 8.00 cores allocatable (50%)');
  });

  it('shows the focus total when zoomed, with no capacity share', () => {
    expect(usedText(tree, 'cpu', ['sys'], 'System')).toBe('3.00 cores in System');
  });

  it('reads zoomed into a node of a node ring like a single-node root', () => {
    const ring: NodeTree = {
      ...tree,
      root: {
        ...tree.root,
        children: [
          { key: 'node:a', label: 'a', value: 3, span: 8, capacity: 8, kind: 'node', children: [] },
        ],
      },
      nodeRing: true,
    };
    expect(usedText(ring, 'cpu', ['node:a'], 'a')).toBe('3.00 cores of 8.00 cores allocatable (38%)');
  });

  it('says so when the tree does not have the focus', () => {
    expect(usedText(tree, 'cpu', ['nope'], 'X')).toBe('no CPU data');
    expect(usedText(tree, 'memory', ['nope'], 'X')).toBe('no memory data');
  });
});

describe('detail figures', () => {
  it('keeps memory shares against capacity', () => {
    const i = { value: 2, ofCapacity: 0.25, ofParent: 0.5, ofRoot: 0.4 };
    expect(figures('Memory', formatCores, i, { zoomed: false, section: 'x', selected: true })).toBe(
      'Memory: 2.00 cores, 25% of capacity'
    );
  });

  const info = { value: 2, ofCapacity: 0.25, ofParent: 0.5, ofRoot: 0.4 };
  const fig = (zoomed: boolean, selected: boolean, i = info) =>
    figures('CPU', formatCores, i, { zoomed, section: 'System', selected });

  it('shows the share of capacity at the root', () => {
    expect(fig(false, true)).toBe('CPU: 2.00 cores, 25% of allocatable');
    expect(fig(false, false)).toBe('CPU: 2.00 cores, 25% of allocatable');
  });

  it('shows the share of the active section for a selection when zoomed', () => {
    expect(fig(true, true)).toBe('CPU: 2.00 cores, 40% of System');
  });

  it('keeps unused capacity as a share of capacity', () => {
    expect(fig(true, true, { ...info, ofRoot: null })).toBe('CPU: 2.00 cores, 25% of allocatable');
  });

  it('shows the value only for the zoom root', () => {
    expect(fig(true, false)).toBe('CPU: 2.00 cores');
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
