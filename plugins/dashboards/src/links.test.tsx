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
  it('keeps a path inside Headlamp as it is', () => {
    expect(resolveLink('/c/main/nodes/a', TARGETS)).toBe('/c/main/nodes/a');
    expect(resolveLink('/dashboards/other/tab', null)).toBe('/dashboards/other/tab');
  });

  it('fills in the cluster of the {cluster} placeholder', () => {
    expect(resolveLink('/c/{cluster}/uptime', TARGETS)).toBe('/c/main/uptime');
    // No cluster in the route: the placeholder cannot be filled, so there is no link.
    expect(resolveLink('/c/{cluster}/uptime', { ...TARGETS, base: '' })).toBeUndefined();
    expect(resolveLink('/c/{cluster}/uptime', null)).toBeUndefined();
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

  it('gives no link for an address with no matching tab', () => {
    expect(
      resolveLink('https://runwarden.example.com/overview', TARGETS, {
        sourceId: 'runwarden',
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
const history = { current: null as ReturnType<typeof useHistory> | null };
const Spy = () => {
  const l = useLocation();
  history.current = useHistory();
  where.current = l.pathname;
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
      'https://runwarden.example.com/overview',
      layout,
      'runwarden'
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

  it('puts the {cluster} placeholder of a path link right', () => {
    const { container } = view('uptime', '/c/{cluster}/uptime', 'list', 'agent');
    expect(container.querySelector('a')?.getAttribute('href')).toBe('/c/main/uptime');
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
