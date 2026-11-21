import { createTheme, ThemeProvider } from '@mui/material/styles';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { queryMetrics, queryRange } = vi.hoisted(() => ({
  queryMetrics: vi.fn(),
  queryRange: vi.fn(),
}));
const { fetchRouteLists } = vi.hoisted(() => ({ fetchRouteLists: vi.fn() }));
vi.mock('./metrics', () => ({ PROBE_JOB: 'uptime', queryMetrics, queryRange }));
vi.mock('./routeApi', () => ({ fetchRouteLists }));

import { normaliseConfig, uptimeTargetsWidget } from './dashboardWidgets';

const NOW_MS = 1_800_000_000_000;
const s = (target: string, location: string, up: number, extra: Record<string, string> = {}) => ({
  metric: {
    target,
    location,
    type: 'http',
    policy: 'all',
    instance: `https://${target}/`,
    ...extra,
  },
  value: [NOW_MS / 1000, String(up)] as [number, string],
});
const series = (target: string, location: string, values: number[]) => ({
  metric: { target, location },
  values: values.map((v, i) => [1_799_990_000 + i * 900, String(v)] as [number, string]),
});

const filters = {
  namespaces: [] as string[],
  nodes: [] as string[],
  labelSelector: '',
  range: '1h' as const,
};
const props = (config: any, over: any = {}) => ({
  instanceId: 'w',
  config: { ...uptimeTargetsWidget.defaultConfig, ...config },
  filters,
  refreshSignal: 0,
  reportRefreshed: vi.fn(),
  editing: false,
  kiosk: false,
  ...over,
});
const Widget = uptimeTargetsWidget.Component;
const view = (ui: React.ReactNode) =>
  render(<ThemeProvider theme={createTheme({ palette: { mode: 'dark' } })}>{ui}</ThemeProvider>);
const flush = () => act(async () => {});

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW_MS);
  queryMetrics.mockReset();
  queryRange.mockReset();
  fetchRouteLists.mockReset();
  fetchRouteLists.mockResolvedValue({
    routes: { httproutes: [], ingresses: [], mappings: [] },
    errors: [],
  });
  queryMetrics.mockResolvedValue([
    s('web-1', 'eu', 1),
    s('web-1', 'hq', 1),
    s('web-2', 'eu', 0),
    s('web-2', 'hq', 0),
    s('db', 'eu', 1),
    s('db', 'hq', 1),
  ]);
  queryRange.mockResolvedValue([
    series('web-2', 'eu', [1, 0, 0]),
    series('web-2', 'hq', [1, 0, 0]),
  ]);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('uptime.targets definition', () => {
  it('has the contract fields', () => {
    expect(uptimeTargetsWidget.type).toBe('uptime.targets');
    // The widget keeps the tiles and the summary fixed and scrolls only its list of groups.
    expect(uptimeTargetsWidget.selfScroll).toBe(false);
    expect(uptimeTargetsWidget.configSchema?.map(f => f.key)).toEqual([
      'groupBy',
      'expanded',
      'range',
      'onlyFailing',
    ]);
    expect(uptimeTargetsWidget.defaultConfig).toEqual({
      groupBy: 'auto',
      expanded: true,
      range: '24h',
      onlyFailing: false,
    });
  });
  it('queues itself on the Dashboards stub when the Dashboards plugin has not loaded', () => {
    const stub = window.headlampDashboards as { stub?: boolean; queue?: Array<{ type: string }> };
    expect(stub.stub).toBe(true);
    expect(stub.queue?.map(d => d.type)).toContain('uptime.targets');
  });
  it('falls back to the defaults for bad saved settings', () => {
    expect(
      normaliseConfig({
        groupBy: 'x' as any,
        expanded: 'y' as any,
        range: 'z' as any,
        onlyFailing: 1 as any,
      })
    ).toEqual(uptimeTargetsWidget.defaultConfig);
    expect(normaliseConfig(undefined)).toEqual(uptimeTargetsWidget.defaultConfig);
  });
});

describe('uptime.targets in the cluster', () => {
  const routes = {
    httproutes: [
      {
        metadata: {
          namespace: 'shop',
          name: 'a',
          labels: { 'app.kubernetes.io/name': 'storefront' },
        },
        spec: { hostnames: ['web-1', 'web-2'].map(h => `${h}.example.com`) },
      },
      { metadata: { namespace: 'ops', name: 'b' }, spec: { hostnames: ['db.example.com'] } },
    ],
    ingresses: [],
    mappings: [],
  };
  const withHosts = () =>
    queryMetrics.mockResolvedValue([
      s('web-1', 'eu', 1, { instance: 'https://web-1.example.com/' }),
      s('web-2', 'eu', 0, { instance: 'https://web-2.example.com/' }),
      s('db', 'eu', 1, { instance: 'https://db.example.com/' }),
      s('github', 'eu', 1, { instance: 'https://github.com/' }),
      s('ssh', 'eu', 1, { instance: 'github.com:22', type: 'tcp' }),
    ]);

  it('groups by the namespace of the route and names the rest by their own host', async () => {
    withHosts();
    fetchRouteLists.mockResolvedValue({ routes, errors: [] });
    view(<Widget {...props({ groupBy: 'namespace' })} />);
    await flush();
    // Every group is listed with no fold row. The failing group comes first, then by name.
    const names = screen.getAllByRole('button').map(b => b.querySelector('p')?.textContent);
    expect(names).toEqual(['shop', 'github.com', 'ops']);
    expect(document.querySelector('[data-uptime-fold]')).toBeNull();
    expect(document.body.textContent).not.toMatch(/more up|Other|Ungrouped|Not in cluster/);
    expect(screen.getByText(/3 groups by namespace/)).toBeTruthy();
  });

  it('auto groups by the app: the route app label, else the namespace, else the host', async () => {
    withHosts();
    fetchRouteLists.mockResolvedValue({ routes, errors: [] });
    view(<Widget {...props({})} />);
    await flush();
    expect(screen.getByText(/groups by app/)).toBeTruthy();
    const names = screen.getAllByRole('button').map(b => b.querySelector('p')?.textContent);
    // The route of db has no app label, so its app is its namespace.
    expect(names).toEqual(['storefront', 'github.com', 'ops']);
    expect(document.body.textContent).not.toMatch(/Other|Ungrouped|Not in cluster/);
  });

  it('lists the routes once per refresh, not once per check', async () => {
    withHosts();
    fetchRouteLists.mockResolvedValue({ routes, errors: [] });
    const p = props({ groupBy: 'namespace' });
    const { rerender } = view(<Widget {...p} />);
    await flush();
    expect(fetchRouteLists).toHaveBeenCalledTimes(1);
    // A settings change regroups from the cached routes.
    rerender(
      <ThemeProvider theme={createTheme({ palette: { mode: 'dark' } })}>
        <Widget {...p} config={{ ...p.config, groupBy: 'app' }} />
      </ThemeProvider>
    );
    await flush();
    expect(fetchRouteLists).toHaveBeenCalledTimes(1);
    rerender(
      <ThemeProvider theme={createTheme({ palette: { mode: 'dark' } })}>
        <Widget {...p} refreshSignal={1} />
      </ThemeProvider>
    );
    await flush();
    expect(fetchRouteLists).toHaveBeenCalledTimes(2);
  });

  it('warns when a route list cannot be read', async () => {
    withHosts();
    fetchRouteLists.mockResolvedValue({ routes, errors: ['mappings: not allowed'] });
    view(<Widget {...props({ groupBy: 'namespace' })} />);
    await flush();
    expect(screen.getByText(/Could not list routes.*mappings: not allowed/)).toBeTruthy();
  });
});

describe('uptime.targets widget', () => {
  it('lists every group, failing first, with counts, and folds none into one row', async () => {
    view(<Widget {...props({})} />);
    await flush();
    const headers = screen.getAllByRole('button');
    expect(headers).toHaveLength(2);
    expect(headers[0].textContent).toContain('web');
    expect(headers[0].textContent).toContain('2 · 1 down · 1 up');
    expect(headers[1].textContent).toContain('db');
    expect(document.body.textContent).not.toMatch(/\bmore\b/);
    expect(document.querySelector('[data-uptime-fold]')).toBeNull();
  });

  it('gives each group its own strip and each check its own strip', async () => {
    view(<Widget {...props({})} />);
    await flush();
    expect(screen.getByLabelText(/^web: Down, the worst of 2 checks/).children.length).toBe(96);
    expect(screen.getByLabelText(/^db: Up, the worst of 1 checks/).children.length).toBe(96);
    expect(screen.getByLabelText(/^web-1: Up, availability/).children.length).toBe(96);
    expect(screen.getByLabelText(/^web-2: Down, availability/).children.length).toBe(96);
    expect(screen.getByLabelText(/^db: Up, availability/).children.length).toBe(96);
  });

  it('expands and collapses a group by click and shows every check', async () => {
    view(<Widget {...props({ expanded: false })} />);
    await flush();
    expect(screen.queryByText('web-1')).toBeNull();
    fireEvent.click(screen.getAllByRole('button')[0]);
    expect(screen.getByText('web-1')).toBeTruthy();
    expect(screen.getByText('web-2')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button')[0]);
    expect(screen.queryByText('web-1')).toBeNull();
  });

  it('starts expanded by default, and a toggle flips from that', async () => {
    view(<Widget {...props({})} />);
    await flush();
    expect(screen.getByText('web-1')).toBeTruthy();
    expect(screen.getByText('web-2')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button')[0]);
    expect(screen.queryByText('web-1')).toBeNull();
    expect(screen.getAllByRole('button')[1].getAttribute('aria-expanded')).toBe('true');
  });

  it('only failing hides the groups that are up', async () => {
    view(<Widget {...props({ onlyFailing: true })} />);
    await flush();
    expect(screen.getAllByRole('button').length).toBe(1);
    expect(screen.getAllByRole('button')[0].textContent).toContain('web');
  });

  it('groups by an app label the probes carry', async () => {
    queryMetrics.mockResolvedValue([
      s('a', 'eu', 1, { app: 'shop' }),
      s('b', 'eu', 1, { app: 'shop' }),
      s('c', 'eu', 1, { app: 'ops' }),
    ]);
    queryRange.mockResolvedValue([]);
    view(<Widget {...props({})} />);
    await flush();
    expect(screen.getAllByRole('button').map(b => b.textContent)).toEqual([
      expect.stringContaining('ops'),
      expect.stringContaining('shop'),
    ]);
  });

  it('shows the stat tiles and the summary line', async () => {
    view(<Widget {...props({})} />);
    await flush();
    expect(
      ['up', 'degraded', 'down', 'unknown'].map(
        s => document.querySelector(`[data-uptime-tile="${s}"]`)?.textContent
      )
    ).toEqual(['2Up', '0Degraded', '1Down', '0No data']);
    expect(document.body.textContent).toContain('2 up, 0 degraded, 1 down, 0 no data');
  });

  it('draws the group line with the page strip and its colours', async () => {
    view(<Widget {...props({})} />);
    await flush();
    const strip = screen.getByLabelText(/^web: Down, the worst of 2 checks/);
    expect(strip.getAttribute('role')).toBe('img');
    expect(strip.children.length).toBe(96);
  });

  it('queries once, again on the refresh signal, and reports the fetch time', async () => {
    const p = props({});
    const { rerender } = view(<Widget {...p} />);
    await flush();
    expect(queryMetrics).toHaveBeenCalledTimes(1);
    expect(queryRange).toHaveBeenCalledTimes(1);
    expect(p.reportRefreshed).toHaveBeenCalledWith(NOW_MS);
    // A new layout or a new object for the same settings does not fetch again.
    rerender(
      <ThemeProvider theme={createTheme({ palette: { mode: 'dark' } })}>
        <Widget {...p} config={{ ...p.config }} />
      </ThemeProvider>
    );
    await flush();
    expect(queryMetrics).toHaveBeenCalledTimes(1);
    rerender(
      <ThemeProvider theme={createTheme({ palette: { mode: 'dark' } })}>
        <Widget {...p} refreshSignal={1} />
      </ThemeProvider>
    );
    await flush();
    expect(queryMetrics).toHaveBeenCalledTimes(2);
  });

  it('keeps the last data when a refresh fails', async () => {
    const p = props({});
    const { rerender } = view(<Widget {...p} />);
    await flush();
    queryMetrics.mockRejectedValue(new Error('proxy down'));
    rerender(
      <ThemeProvider theme={createTheme({ palette: { mode: 'dark' } })}>
        <Widget {...p} refreshSignal={1} />
      </ThemeProvider>
    );
    await flush();
    expect(screen.getByText(/Refresh failed, showing the last data: proxy down/)).toBeTruthy();
    expect(screen.getAllByRole('button').length).toBe(2);
  });

  it('shows an error when the first fetch fails', async () => {
    queryMetrics.mockRejectedValue(new Error('proxy down'));
    view(<Widget {...props({})} />);
    await flush();
    expect(screen.getByText(/Could not read probe results: proxy down/)).toBeTruthy();
  });

  it('keeps the tiles and the summary outside the one scroll area that holds the groups', async () => {
    const { container } = view(<Widget {...props({}, { kiosk: true })} />);
    await flush();
    const areas = container.querySelectorAll('[data-scroll-area]');
    expect(areas).toHaveLength(1);
    const area = areas[0] as HTMLElement;
    // Every group and every check is inside the scroll area. The tiles and the summary are not.
    expect(area.querySelectorAll('[data-uptime-group]')).toHaveLength(2);
    expect(area.contains(document.querySelector('[data-uptime-tiles]'))).toBe(false);
    expect(area.contains(document.querySelector('[data-widget-summary]'))).toBe(false);
    expect(document.querySelector('[data-widget-summary]')).toBeTruthy();
    expect(getComputedStyle(area).overflowY).toBe('auto');
    expect(getComputedStyle(area).overscrollBehavior).toBe('contain');
  });
});
