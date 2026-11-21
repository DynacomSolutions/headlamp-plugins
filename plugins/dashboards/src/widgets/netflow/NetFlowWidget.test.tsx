import { createTheme, ThemeProvider } from '@mui/material/styles';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const request = vi.fn();
vi.mock('@iconify/react', () => ({ Icon: (p: { icon: string }) => <i data-icon={p.icon} /> }));
vi.mock('@kinvolk/headlamp-plugin/lib', () => ({
  ApiProxy: { request: (...a: unknown[]) => request(...a) },
  ConfigStore: class {
    useConfig() {
      return () => undefined;
    }
  },
}));

import type { WidgetProps } from '../../contract';
import { defaultFilters } from '../../spec/model';
import { BUILTIN_WIDGETS, registerBuiltinWidgets } from '../builtin';
import { DEFAULT_NET_FLOW } from './config';
import { NETFLOW_WIDGETS } from './index';
import { netFlowWidget } from './NetFlowWidget';

const reply = (result: unknown) => ({
  ok: true,
  status: 200,
  json: async () => ({ status: 'success', data: { resultType: 'vector', result } }),
});
const ping = (source: string, target: string, network: string, v: string) => ({
  metric: { source, target, network },
  value: [1, v],
});
const byte = (source: string, target: string, direction: string, v: string) => ({
  metric: { source, target, network: 'tailnet', direction },
  value: [1, v],
});
const inst = (instance: string, v: string) => ({ metric: { instance }, value: [1, v] });

/** Three nodes. Tailnet has data on every pair, LAN on one pair, public on none. */
const answer = (url: string) => {
  const q = decodeURIComponent(url);
  if (q.includes('net_ping_loss_ratio'))
    return reply([
      ping('a', 'b', 'tailnet', '0'),
      ping('b', 'a', 'tailnet', '0'),
      ping('a', 'c', 'tailnet', '0.05'),
      ping('c', 'a', 'tailnet', '0'),
      ping('b', 'c', 'tailnet', '0.004'),
      ping('a', 'b', 'lan', '0.03'),
    ]);
  if (q.includes('ping_rtt')) return reply([ping('a', 'b', 'tailnet', '0.0123')]);
  if (q.includes('peer_bytes'))
    return reply([byte('a', 'b', 'tx', '2048'), byte('b', 'a', 'tx', '512')]);
  if (q.includes('node_uname_info'))
    return reply([
      { metric: { instance: '192.0.2.1:9100', nodename: 'a' }, value: [1, '1'] },
      { metric: { instance: '192.0.2.2:9100', nodename: 'b' }, value: [1, '1'] },
      { metric: { instance: '192.0.2.3:9100', nodename: 'c' }, value: [1, '1'] },
    ]);
  if (q.includes('tailscale'))
    return reply([inst('192.0.2.1:9100', '0.03'), inst('192.0.2.2:9100', '0.001')]);
  if (q.includes('eno.*')) return reply([inst('192.0.2.1:9100', '0'), inst('192.0.2.2:9100', '0')]);
  if (q.includes('Tcp_RetransSegs')) return reply([inst('192.0.2.1:9100', '0.0042')]);
  return reply([]);
};

function props(over: Partial<WidgetProps<typeof DEFAULT_NET_FLOW>> = {}) {
  return {
    instanceId: 'w1',
    config: DEFAULT_NET_FLOW,
    filters: defaultFilters(),
    refreshSignal: 0,
    reportRefreshed: vi.fn(),
    editing: false,
    kiosk: false,
    ...over,
  };
}

beforeEach(() => {
  request.mockReset();
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 420 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, value: 330 });
});
afterEach(cleanup);

const C = netFlowWidget.Component;
const renderIt = (p = props()) =>
  render(
    <ThemeProvider theme={createTheme({ palette: { mode: 'dark' } })}>
      <C {...p} />
    </ThemeProvider>
  );

describe('network flow widget', () => {
  it('registers as network.flow and leaves the promql widgets alone', () => {
    expect(NETFLOW_WIDGETS.map(w => w.type)).toEqual(['network.flow']);
    const types: string[] = [];
    registerBuiltinWidgets({
      registerWidget: (w: { type: string }) => types.push(w.type),
    } as never);
    expect(types).toContain('network.flow');
    expect(types).toContain('promql.matrix');
    expect(BUILTIN_WIDGETS.length).toBeGreaterThan(0);
  });

  it('draws one circle for each node and one line for each pair', async () => {
    request.mockImplementation(async (url: string) => answer(url));
    const { container } = renderIt();
    await waitFor(() => expect(container.querySelectorAll('[data-flow-pair]').length).toBe(3));
    expect(container.querySelectorAll('[data-flow-node]')).toHaveLength(3);
    const pair = (k: string) => container.querySelector(`[data-flow-pair="${k}"]`)!;
    // The worst direction and the worst network decide the colour ("all").
    expect(pair('a|b').getAttribute('data-status')).toBe('crit');
    expect(pair('a|c').getAttribute('data-status')).toBe('crit');
    expect(pair('b|c').getAttribute('data-status')).toBe('warn');
    // Warning and critical lines have a shape at the middle.
    expect(pair('b|c').querySelector('path')).toBeTruthy();
    expect(pair('a|c').querySelector('rect')).toBeTruthy();
    // A line with traffic is wider than a line with none.
    expect(Number(pair('a|b').getAttribute('data-width'))).toBeGreaterThan(
      Number(pair('a|c').getAttribute('data-width'))
    );
    expect(Number(pair('a|c').getAttribute('data-width'))).toBe(1);
  });

  it('shows the three networks as chips and filters the graph with them', async () => {
    request.mockImplementation(async (url: string) => answer(url));
    const { container } = renderIt();
    await waitFor(() => expect(container.querySelectorAll('[data-flow-pair]').length).toBe(3));
    const chips = [...container.querySelectorAll('[data-flow-chip]')].map(c => c.textContent);
    expect(chips).toEqual(['All', 'Tailnet', 'LAN', 'Public']);
    const pair = (k: string) => container.querySelector(`[data-flow-pair="${k}"]`)!;
    fireEvent.click(container.querySelector('[data-flow-chip="tailnet"]')!);
    expect(container.querySelector('[data-net-flow]')?.getAttribute('data-selection')).toBe(
      'tailnet'
    );
    expect(pair('a|b').getAttribute('data-status')).toBe('ok');
    fireEvent.click(container.querySelector('[data-flow-chip="lan"]')!);
    expect(pair('a|b').getAttribute('data-status')).toBe('crit');
    // A pair with no LAN data is grey, never ok.
    expect(pair('a|c').getAttribute('data-status')).toBe('unknown');
    fireEvent.click(container.querySelector('[data-flow-chip="public"]')!);
    expect(
      ['a|b', 'a|c', 'b|c'].every(k => pair(k).getAttribute('data-status') === 'unknown')
    ).toBe(true);
    expect(container.querySelector('[data-flow-chip="public"]')?.getAttribute('aria-checked')).toBe(
      'true'
    );
    // The page URL does not change.
    expect(window.location.search).toBe('');
  });

  it('lists every node with its shares and shows no data as a dash', async () => {
    request.mockImplementation(async (url: string) => answer(url));
    const { container } = renderIt();
    await waitFor(() => expect(container.querySelectorAll('[data-flow-row]').length).toBe(3));
    const row = (n: string) => container.querySelector(`[data-flow-row="${n}"]`)!;
    expect(row('a').textContent).toContain('3%');
    expect(row('a').textContent).toContain('0.42%');
    expect(row('a').getAttribute('data-status')).toBe('crit');
    expect(row('b').getAttribute('data-status')).toBe('ok');
    expect(row('c').getAttribute('data-status')).toBe('unknown');
    expect(row('c').textContent).toBe('c----');
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/\+\s?\d+ more|\bmore\b/i);
    expect(text).not.toMatch(/\bOther\b/);
  });

  it('shows the summary line', async () => {
    request.mockImplementation(async (url: string) => answer(url));
    const { container } = renderIt();
    await waitFor(() => expect(container.querySelector('[data-flow-summary]')).toBeTruthy());
    expect(container.querySelector('[data-flow-summary]')?.textContent).toBe(
      '3 pairs, with data: Tailnet 3, LAN 1, Public 0, 2 above 2%, worst a to c 5%'
    );
  });

  it('opens a tooltip with loss, round trip and rate of each direction', async () => {
    request.mockImplementation(async (url: string) => answer(url));
    const { container } = renderIt();
    await waitFor(() => expect(container.querySelectorAll('[data-flow-pair]').length).toBe(3));
    fireEvent.mouseEnter(container.querySelector('[data-flow-pair="a|b"]')!);
    const tip = container.querySelector('[data-flow-tip]')!;
    expect(tip.textContent).toContain('a and b');
    expect(tip.textContent).toContain('Tailnet: loss 0%');
    expect(tip.textContent).toContain('LAN: loss 3%');
    expect(tip.textContent).toContain('a to b, loss 0%, round trip 12.3 ms, traffic 2 KiB/s');
    expect(tip.textContent).toContain('b to a, loss 0%, round trip no data, traffic 512 B/s');
    fireEvent.mouseLeave(container.querySelector('[data-flow-graph]')!);
    expect(container.querySelector('[data-flow-tip]')).toBeNull();
  });

  it('runs the eight queries and falls back when a network has no series', async () => {
    request.mockImplementation(async (url: string) => {
      const q = decodeURIComponent(url);
      // Only the old tailnet series exist: the fallback in the query returns them as tailnet.
      if (q.includes('net_ping_loss_ratio'))
        return reply([ping('a', 'b', 'tailnet', '0'), ping('b', 'a', 'tailnet', '0')]);
      return reply([]);
    });
    const { container } = renderIt();
    await waitFor(() => expect(container.querySelectorAll('[data-flow-pair]').length).toBe(1));
    expect(request).toHaveBeenCalledTimes(8);
    expect(container.querySelector('[data-flow-summary]')?.textContent).toContain(
      'Tailnet 1, LAN 0, Public 0'
    );
    // No traffic series: the thin minimum width. No health series: the rows have dashes.
    expect(container.querySelector('[data-flow-pair="a|b"]')?.getAttribute('data-width')).toBe(
      '1.00'
    );
    expect(container.querySelector('[data-flow-row="a"]')?.getAttribute('data-status')).toBe(
      'unknown'
    );
  });

  it('says so when the queries return nothing and shows an error when the fetch fails', async () => {
    request.mockResolvedValue(reply([]));
    const a = renderIt();
    await waitFor(() => expect(a.container.textContent).toContain('returned no network data'));
    cleanup();
    request.mockRejectedValue(new Error('boom'));
    const b = renderIt();
    await waitFor(() => expect(b.container.textContent).toContain('boom'));
  });
});
