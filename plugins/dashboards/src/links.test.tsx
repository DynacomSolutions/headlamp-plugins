import { createTheme, ThemeProvider } from '@mui/material/styles';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { MemoryRouter, Route, useHistory, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@kinvolk/headlamp-plugin/lib', () => ({
  ApiProxy: { request: vi.fn(), clusterRequest: vi.fn() },
  K8s: { useClustersConf: () => ({}), useCluster: () => null },
  ConfigStore: class {
    useConfig() {
      return () => undefined;
    }
    get() {
      return undefined;
    }
  },
}));

import { InternalLink, isAppPath, LinkContext, LinkTargets, resolveLink } from './links';
import { parsePanel } from './widgets/panels/model';
import { PanelView, RowLayout } from './widgets/panels/PanelView';
import type { PanelSource } from './widgets/panels/sources';

afterEach(cleanup);

const TARGETS: LinkTargets = {
  base: '/c/main',
  dashboard: 'operations',
  tabs: ['overview', 'hoarddb', 'ais-console', 'uptime', 'incidents'],
};

describe('resolveLink', () => {
  it('keeps a path of the same dashboard, with its focus segments', () => {
    expect(resolveLink('/c/main/dashboards/operations/uptime', TARGETS)).toBe(
      '/c/main/dashboards/operations/uptime'
    );
    expect(resolveLink('/c/main/dashboards/operations/incidents/group/HighCPU', TARGETS)).toBe(
      '/c/main/dashboards/operations/incidents/group/HighCPU'
    );
    expect(resolveLink('/c/main/dashboards/operations', TARGETS)).toBe(
      '/c/main/dashboards/operations'
    );
    // The query and the hash belong to the current view, so the link does not carry its own.
    expect(resolveLink('/c/main/dashboards/operations/uptime?kiosk=0#x', TARGETS)).toBe(
      '/c/main/dashboards/operations/uptime'
    );
  });

  it('gives no link to another dashboard, another cluster, another tab or the list', () => {
    expect(resolveLink('/c/main/dashboards/other/uptime', TARGETS)).toBeUndefined();
    expect(resolveLink('/c/second/dashboards/operations/uptime', TARGETS)).toBeUndefined();
    expect(resolveLink('/c/main/dashboards/operations/nosuchtab', TARGETS)).toBeUndefined();
    expect(resolveLink('/c/main/dashboards', TARGETS)).toBeUndefined();
    expect(resolveLink('/dashboards/other/tab', null)).toBeUndefined();
  });

  it('gives no link to a Headlamp page that is not a tab of the dashboard', () => {
    expect(resolveLink('/c/main/nodes/a', TARGETS)).toBeUndefined();
    expect(resolveLink('/c/main/github-runners', TARGETS)).toBeUndefined();
    expect(resolveLink('/c/{cluster}/nodes', TARGETS)).toBeUndefined();
    expect(resolveLink('/c/main/nodes', null)).toBeUndefined();
  });

  it('fills in the cluster of the {cluster} placeholder', () => {
    expect(resolveLink('/c/{cluster}/dashboards/operations/uptime', TARGETS)).toBe(
      '/c/main/dashboards/operations/uptime'
    );
    // No cluster in the route: the placeholder cannot be filled, so there is no link.
    expect(
      resolveLink('/c/{cluster}/dashboards/operations/uptime', { ...TARGETS, base: '' })
    ).toBeUndefined();
    expect(resolveLink('/c/{cluster}/dashboards/operations/uptime', null)).toBeUndefined();
  });

  const MAPPING: Array<[string, { sourceId?: string; panelId?: string }, string]> = [
    // AIS rows go to the AIS Console tab.
    [
      'https://ais.example.com/limits',
      { sourceId: 'ais-console', panelId: 'limits' },
      'ais-console',
    ],
    [
      'https://ais.example.com/auth',
      { sourceId: 'ais-console', panelId: 'identities' },
      'ais-console',
    ],
    // HoardDB rows go to the HoardDB tab.
    [
      'https://hoarddb.example.com/engines/pg-shared',
      { sourceId: 'hoarddb', panelId: 'engines' },
      'hoarddb',
    ],
    // The panel id wins over the source id: uptime rows of the agent go to the Uptime tab.
    ['https://example.com/', { sourceId: 'agent', panelId: 'uptime' }, 'uptime'],
    ['https://example.com/', { sourceId: 'agent', panelId: 'incidents' }, 'incidents'],
  ];
  it.each(MAPPING)('maps %s to the tab of its panel or source', (link, origin, tab) => {
    expect(resolveLink(link, TARGETS, origin)).toBe(`/c/main/dashboards/operations/${tab}`);
  });

  describe('a path to a Headlamp page that is a tab of the dashboard', () => {
    const UPTIME = { sourceId: 'agent', panelId: 'uptime' };
    const TAB = '/c/main/dashboards/operations/uptime';
    it('opens the tab, with the cluster filled in or already in the path', () => {
      expect(resolveLink('/c/{cluster}/uptime', TARGETS, UPTIME)).toBe(TAB);
      expect(resolveLink('/c/main/uptime', TARGETS, UPTIME)).toBe(TAB);
      expect(resolveLink('/uptime', TARGETS, UPTIME)).toBe(TAB);
      expect(resolveLink('/c/main/uptime?x=1', TARGETS, UPTIME)).toBe(TAB);
    });

    it('gives no link when there is no such tab or the row comes from another panel', () => {
      expect(
        resolveLink('/c/main/uptime', { ...TARGETS, tabs: ['overview'] }, UPTIME)
      ).toBeUndefined();
      expect(
        resolveLink('/c/main/uptime', TARGETS, { sourceId: 'agent', panelId: 'disks' })
      ).toBeUndefined();
      expect(resolveLink('/c/main/uptime', TARGETS)).toBeUndefined();
      expect(resolveLink('/c/main/uptime', null, UPTIME)).toBeUndefined();
    });

    it('gives no link for a path that goes deeper than the page', () => {
      expect(resolveLink('/c/main/uptime/site-a', TARGETS, UPTIME)).toBeUndefined();
      expect(resolveLink('/c/main/nodes/a', TARGETS, { panelId: 'nodes' })).toBeUndefined();
    });

    it('never gives a link to another host', () => {
      for (const raw of ['https://uptime.example.com/uptime', '//uptime.example.com/uptime'])
        expect(resolveLink(raw, TARGETS, UPTIME) ?? '/').toMatch(/^\/(?!\/)/);
    });
  });

  it('gives no link for an address with no matching tab', () => {
    expect(
      resolveLink('https://runners.example.com/overview', TARGETS, {
        sourceId: 'runners',
        panelId: 'pools',
      })
    ).toBeUndefined();
    expect(resolveLink('https://example.com', TARGETS)).toBeUndefined();
    expect(resolveLink('https://example.com', null, { sourceId: 'hoarddb' })).toBeUndefined();
  });

  it('never gives an external or unsafe address', () => {
    for (const bad of [
      'http://example.com/x',
      'HTTPS://example.com/x',
      '//example.com/x',
      '/\\example.com',
      'javascript:alert(1)',
      'mailto:a@example.com',
      'data:text/html,x',
      'ais.example.com',
      '',
      undefined,
      42,
    ]) {
      const out = resolveLink(bad, TARGETS);
      expect(out === undefined || out.startsWith('/')).toBe(true);
      expect(out ?? '').not.toMatch(/example\.com|:/);
    }
  });

  it('knows an app path', () => {
    expect(isAppPath('/a')).toBe(true);
    expect(isAppPath('//a')).toBe(false);
    expect(isAppPath('https://a')).toBe(false);
    expect(isAppPath('/a\nb')).toBe(false);
    expect(isAppPath(undefined)).toBe(false);
  });
});

describe('InternalLink', () => {
  it('renders no anchor for an address on another host', () => {
    const { container } = render(
      <MemoryRouter>
        <InternalLink to="https://ais.example.com/limits">AIS</InternalLink>
      </MemoryRouter>
    );
    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent).toBe('AIS');
  });

  it('keeps the current query, so a click never leaves kiosk mode', () => {
    const { container } = render(
      <MemoryRouter initialEntries={['/c/main/dashboards/operations?kiosk=1&ns=a&w.x=2']}>
        <InternalLink to="/c/main/dashboards/operations/uptime">Uptime</InternalLink>
      </MemoryRouter>
    );
    const a = container.querySelector('a') as HTMLAnchorElement;
    expect(a.getAttribute('href')).toBe(
      '/c/main/dashboards/operations/uptime?kiosk=1&ns=a&w.x=2'
    );
    expect(a.getAttribute('target')).toBeNull();
  });

  it('keeps the query after a click', () => {
    const { container } = render(
      <MemoryRouter initialEntries={['/c/main/dashboards/operations?kiosk=1&refresh=30']}>
        <Route path="*" component={Spy} />
        <InternalLink to="/c/main/dashboards/operations/uptime">Uptime</InternalLink>
      </MemoryRouter>
    );
    fireEvent.click(container.querySelector('a') as HTMLAnchorElement);
    expect(where.current).toBe('/c/main/dashboards/operations/uptime');
    expect(search.current).toBe('?kiosk=1&refresh=30');
  });
});

const source = (id: string): PanelSource => ({
  id,
  title: id,
  kind: 'service',
  namespace: 'ns',
  service: 'svc',
  port: '80',
  pathPrefix: '',
});

const where = { current: '' };
const search = { current: '' };
const history = { current: null as ReturnType<typeof useHistory> | null };
const Spy = () => {
  const l = useLocation();
  history.current = useHistory();
  where.current = l.pathname;
  search.current = l.search;
  return null;
};

function view(
  panelId: string,
  link: string,
  layout: RowLayout,
  sourceId: string,
  targets: LinkTargets | null = TARGETS
) {
  const panel = parsePanel({
    version: 1,
    id: panelId,
    title: panelId,
    status: 'warn',
    rows: [
      { label: 'acme', detail: '5h', value: '90%', fraction: 0.9, status: 'crit', link },
      { label: 'beta', detail: '5h', value: '20%', fraction: 0.2, status: 'warn', link },
    ],
  });
  return render(
    <MemoryRouter initialEntries={['/c/main/dashboards/operations']}>
      <Route path="*" component={Spy} />
      <LinkContext.Provider value={targets}>
        <ThemeProvider theme={createTheme()}>
          <PanelView
            panel={panel}
            kiosk={false}
            editing={false}
            display={{ showSummary: true, showStats: true, rowLayout: layout }}
            source={source(sourceId)}
          />
        </ThemeProvider>
      </LinkContext.Provider>
    </MemoryRouter>
  );
}

const LAYOUTS: RowLayout[] = ['list', 'grouped-bars', 'stacked-lanes'];

describe('panel row links', () => {
  it.each(LAYOUTS)('an https row link never renders as a link to that host (%s)', layout => {
    const { container } = view('limits', 'https://ais.example.com/limits', layout, 'ais-console');
    const anchors = Array.from(container.querySelectorAll('a'));
    expect(anchors.length).toBeGreaterThan(0);
    for (const a of anchors) {
      expect(a.getAttribute('href')).toBe('/c/main/dashboards/operations/ais-console');
      expect(a.getAttribute('target')).toBeNull();
    }
    expect(container.innerHTML).not.toContain('ais.example.com');
  });

  it.each(LAYOUTS)('an https row link with no matching tab shows no link (%s)', layout => {
    const { container } = view(
      'pools',
      'https://runners.example.com/overview',
      layout,
      'runners'
    );
    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent).toContain('acme');
  });

  it('shows no link at all outside a dashboard', () => {
    const { container } = view(
      'limits',
      'https://ais.example.com/limits',
      'list',
      'ais-console',
      null
    );
    expect(container.querySelector('a')).toBeNull();
  });

  it('opens the uptime tab for an uptime row with a path link to the Uptime page', () => {
    const { container } = view('uptime', '/c/{cluster}/uptime', 'list', 'agent');
    const anchors = Array.from(container.querySelectorAll('a'));
    expect(anchors.length).toBeGreaterThan(0);
    for (const a of anchors)
      expect(a.getAttribute('href')).toBe('/c/main/dashboards/operations/uptime');
  });

  it('shows an uptime row as text when the dashboard has no uptime tab', () => {
    const { container } = view('uptime', '/c/{cluster}/uptime', 'list', 'agent', {
      ...TARGETS,
      tabs: ['overview'],
    });
    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent).toContain('acme');
  });

  it('shows a row with a link to another Headlamp page as text', () => {
    const { container } = view('nodes', '/c/{cluster}/nodes', 'list', 'agent');
    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent).toContain('acme');
  });

  it('follows a link with a history push, so Back returns to the dashboard', () => {
    const { container } = view(
      'hoarddb-engines',
      'https://hoarddb.example.com/engines',
      'list',
      'hoarddb'
    );
    expect(where.current).toBe('/c/main/dashboards/operations');
    fireEvent.click(container.querySelector('a') as HTMLAnchorElement);
    expect(where.current).toBe('/c/main/dashboards/operations/hoarddb');
    act(() => history.current?.goBack());
    expect(where.current).toBe('/c/main/dashboards/operations');
    expect(screen.getByText('acme')).toBeTruthy();
  });
});
