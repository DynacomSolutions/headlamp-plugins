import { createTheme, ThemeProvider } from '@mui/material/styles';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('@kinvolk/headlamp-plugin/lib', () => ({
  ApiProxy: { request },
  ConfigStore: class {
    useConfig() {
      return () => undefined;
    }
  },
}));

import { SunburstChart } from '../sunburst/SunburstChart';
import { clearPanelListCache } from './data';
import { parsePanel } from './model';
import { PanelView } from './PanelView';
import { panelWidget } from './PanelWidget';
import { sparklinePoints } from './Sparkline';

const wrap = (ui: React.ReactNode, mode: 'light' | 'dark' = 'light') => (
  <MemoryRouter>
    <ThemeProvider theme={createTheme({ palette: { mode } })}>{ui}</ThemeProvider>
  </MemoryRouter>
);

const PANEL = {
  id: 'usage-dashboard',
  title: 'Usage',
  status: 'warn',
  summary: 'Busy',
  stats: [{ label: 'Nodes', value: '3', status: 'ok' }],
  rows: [
    { label: 'node-a', detail: 'hot', value: '90%', fraction: 0.9, status: 'crit', link: '/c/main/nodes/node-a' },
    { label: 'node-b', detail: '', value: '10%', fraction: 0.1, status: 'ok' },
  ],
  series: [{ label: 'CPU', points: [1, 3, 2] }],
  rings: [{ id: 'cpu', label: 'CPU', unit: 'cores', capacity: 8, used: 4, segments: [{ key: 'k8s', label: 'Kubernetes', value: 3, children: [{ key: 'k8s/ns:shop', label: 'shop', value: 2 }] }, { key: 'sys', label: 'System', value: 1 }] }],
};

beforeEach(() => {
  request.mockReset();
  clearPanelListCache();
});
afterEach(cleanup);

describe('PanelView', () => {
  it('draws status, tiles, rows with bars and links, sparklines and a sunburst', () => {
    const { container } = render(wrap(<PanelView panel={parsePanel(PANEL)} kiosk={false} editing={false} />));
    expect(container.querySelector('[data-panel-summary]')?.textContent).toBe('Busy');
    expect(container.querySelectorAll('[data-stat]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-row]')).toHaveLength(2);
    expect(container.querySelectorAll('[data-fraction]')).toHaveLength(2);
    expect(container.querySelector('a[href="/c/main/nodes/node-a"]')?.textContent).toBe('node-a');
    expect(container.querySelectorAll('[data-sparkline]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-arc="category"]')).toHaveLength(2);
    expect(container.querySelectorAll('[data-arc="child"]')).toHaveLength(1);
  });
  it('turns links off while editing', () => {
    const { container } = render(wrap(<PanelView panel={parsePanel(PANEL)} kiosk={false} editing />));
    expect(container.querySelector('a')).toBeNull();
  });
  it('shows the status as a shape with a word, not colour alone', () => {
    const { container } = render(wrap(<PanelView panel={parsePanel(PANEL)} kiosk={false} editing={false} />));
    const labels = Array.from(container.querySelectorAll('svg[data-status]')).map(s => s.getAttribute('aria-label'));
    expect(labels).toContain('Warning');
    expect(labels).toContain('Critical');
    expect(labels).toContain('OK');
  });
  it('shows an empty state', () => {
    const { container } = render(wrap(<PanelView panel={parsePanel({ id: 'x' })} kiosk={false} editing={false} />));
    expect(container.querySelector('[data-panel-empty]')).not.toBeNull();
  });
});

describe('SunburstChart', () => {
  const data = { capacity: 10, categories: [{ key: 'a', label: 'Alpha', value: 6, children: [{ key: 'a1', label: 'Child', value: 4 }] }, { key: 'b', label: 'Beta', value: 2 }] };
  const fmt = (v: number) => `${v} u`;
  it('shows the label and value of an arc on hover and clears them again', () => {
    const { container } = render(wrap(<SunburstChart data={data} title="CPU" format={fmt} />));
    const centre = () => container.querySelector('[data-sunburst-centre]')!.textContent;
    expect(centre()).toContain('CPU');
    fireEvent.mouseEnter(container.querySelector('[data-arc="child"]')!);
    expect(centre()).toContain('Child');
    expect(centre()).toContain('4 u');
    fireEvent.mouseLeave(container.querySelector('[data-arc="child"]')!);
    expect(centre()).toContain('CPU');
  });
  it('selects an arc with a tap and in kiosk mode does not react to hover', () => {
    const { container } = render(wrap(<SunburstChart data={data} title="CPU" format={fmt} kiosk />, 'dark'));
    const arc = container.querySelector('[data-arc="category"]')!;
    fireEvent.mouseEnter(arc);
    expect(container.querySelector('[data-sunburst-centre]')!.textContent).not.toContain('Alpha');
    fireEvent.click(arc);
    expect(container.querySelector('[data-sunburst-centre]')!.textContent).toContain('Alpha');
    fireEvent.click(arc);
    expect(container.querySelector('[data-sunburst-centre]')!.textContent).not.toContain('Alpha');
  });
  it('lists every category in the legend and has a text summary', () => {
    const { container } = render(wrap(<SunburstChart data={data} title="CPU" format={fmt} />));
    expect(container.querySelectorAll('ul li')).toHaveLength(2);
    expect(container.querySelector('svg')?.getAttribute('aria-label')).toMatch(/Alpha 60%/);
  });
  it('renders without data', () => {
    const { container } = render(wrap(<SunburstChart data={{ capacity: 0, categories: [] }} title="CPU" format={fmt} />));
    expect(container.querySelectorAll('[data-arc]')).toHaveLength(0);
    expect(container.querySelector('svg')?.getAttribute('aria-label')).toBe('CPU: no usage');
  });
});

describe('sparklinePoints', () => {
  it('scales a series into the box and draws a flat series in the middle', () => {
    const p = sparklinePoints([0, 10], 100, 20, 0);
    expect(p).toEqual([[0, 20], [100, 0]]);
    expect(sparklinePoints([5, 5], 100, 20, 0).map(x => x[1])).toEqual([10, 10]);
    expect(sparklinePoints([], 100, 20)).toEqual([]);
  });
});

describe('agent panel widget', () => {
  const Component = panelWidget.Component;
  const props = (over: Partial<React.ComponentProps<typeof Component>> = {}) => ({
    instanceId: 'w1',
    config: { panel: 'usage-dashboard' },
    filters: { namespaces: [], nodes: [], labelSelector: '', range: '1h' as const },
    refreshSignal: 0,
    reportRefreshed: vi.fn(),
    editing: false,
    kiosk: false,
    ...over,
  });
  const answer = (url: string) => {
    if (url.endsWith('/api/widgets')) return Promise.resolve([{ id: 'usage-dashboard', title: 'Usage', description: '', plugin: 'usage', link: '/usage', refreshSeconds: 60 }]);
    if (url.includes('/api/widgets/usage-dashboard')) return Promise.resolve(PANEL);
    return Promise.reject(new Error('unexpected'));
  };

  it('asks for a panel when none is chosen', async () => {
    request.mockImplementation(answer);
    render(wrap(<Component {...props({ config: { panel: '' } })} />));
    expect(screen.getByText(/Choose a panel/)).toBeTruthy();
  });

  it('loads the panel, reports the refresh and honours the minimum interval', async () => {
    request.mockImplementation(answer);
    const p = props();
    const view = render(wrap(<Component {...p} />));
    expect(screen.getByLabelText('Loading the panel')).toBeTruthy();
    await act(async () => {
      await Promise.resolve();
    });
    expect(view.container.querySelector('[data-panel="usage-dashboard"]')).not.toBeNull();
    expect(p.reportRefreshed).toHaveBeenCalledTimes(1);
    const panelCalls = () => request.mock.calls.filter(c => String(c[0]).includes('/api/widgets/usage')).length;
    expect(panelCalls()).toBe(1);
    // A refresh signal 0 s later is inside the 60 s minimum, so it does not fetch again.
    view.rerender(wrap(<Component {...p} refreshSignal={1} />));
    await act(async () => {
      await Promise.resolve();
    });
    expect(panelCalls()).toBe(1);
  });

  it('keeps the last panel and shows a warning when a refresh fails', async () => {
    let fail = false;
    request.mockImplementation((url: string) => (fail && url.includes('/api/widgets/usage') ? Promise.reject(new Error('HTTP 502')) : answer(url)));
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const p = props();
      const view = render(wrap(<Component {...p} />));
      await act(async () => {
      await Promise.resolve();
    });
      fail = true;
      vi.setSystemTime(Date.now() + 120_000);
      view.rerender(wrap(<Component {...p} refreshSignal={1} />));
      await act(async () => {
      await Promise.resolve();
    });
      expect(screen.getByText(/Refresh failed, showing the last data: HTTP 502/)).toBeTruthy();
      expect(view.container.querySelector('[data-panel]')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows an error when the first load fails', async () => {
    request.mockImplementation((url: string) => (url.includes('/api/widgets/usage') ? Promise.reject(new Error('HTTP 404')) : answer(url)));
    render(wrap(<Component {...props()} />));
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText(/Could not load the panel: HTTP 404/)).toBeTruthy();
  });

  it('is registered with a settings component and no raw id in its defaults', () => {
    expect(panelWidget.type).toBe('agent.panel');
    expect(panelWidget.defaultConfig).toEqual({ panel: '' });
    expect(panelWidget.SettingsComponent).toBeDefined();
  });
});
