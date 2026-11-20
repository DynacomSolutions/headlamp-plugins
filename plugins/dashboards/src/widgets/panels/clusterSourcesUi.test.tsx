import { createTheme, ThemeProvider } from '@mui/material/styles';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { request, clusterRequest, settings } = vi.hoisted(() => ({
  request: vi.fn(),
  clusterRequest: vi.fn(),
  settings: { value: undefined as Record<string, unknown> | undefined },
}));
vi.mock('@kinvolk/headlamp-plugin/lib', () => ({
  ApiProxy: { request, clusterRequest },
  K8s: { useClustersConf: () => ({ main: {} }), useCluster: () => null },
  ConfigStore: class {
    useConfig() {
      return () => settings.value;
    }
    get() {
      return settings.value;
    }
  },
}));

import { clearClusterSources } from './clusterSources';
import { clearPanelListCache } from './data';
import { PanelWidget } from './PanelWidget';
import { CLUSTER_SOURCES_KEY, CLUSTER_SOURCES_LABEL } from './sources';
import { useSources } from './sourcesConfig';
import { SourcesSettingsSection } from './SourcesSettingsSection';
import { variantWidgets } from './variants';

const wrap = (ui: React.ReactNode) => (
  <MemoryRouter>
    <ThemeProvider theme={createTheme()}>{ui}</ThemeProvider>
  </MemoryRouter>
);

const svc = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: `Title ${id}`,
  icon: 'mdi:database',
  kind: 'service',
  namespace: 'apps',
  service: id,
  port: '80',
  ...extra,
});

let version = 4;
let stored: any[] = [svc('shared-one'), svc('shared-two')];
let allowed = true;
let readStatus: number | null = null;

const configMap = () => ({
  metadata: {
    name: 'dashboard-sources',
    namespace: 'headlamp-dashboards',
    resourceVersion: String(version),
    labels: { [CLUSTER_SOURCES_LABEL]: 'true' },
  },
  data: { [CLUSTER_SOURCES_KEY]: JSON.stringify({ version: 1, sources: stored }) },
});

const answer = async (path: string, params?: any) => {
  if (path.startsWith('/apis/authorization'))
    return {
      status: { allowed: JSON.parse(params.body).spec.resourceAttributes.verb !== 'x' && allowed },
    };
  if (path.includes('/configmaps')) {
    if (params?.method === 'PUT') {
      const body = JSON.parse(params.body);
      if (body.metadata.resourceVersion !== String(version))
        throw Object.assign(new Error('conflict'), { status: 409 });
      version += 1;
      stored = JSON.parse(body.data[CLUSTER_SOURCES_KEY]).sources;
      return configMap();
    }
    if (readStatus) throw Object.assign(new Error('no'), { status: readStatus });
    return { items: [configMap()] };
  }
  if (path.endsWith('/api/widgets'))
    return {
      version: 1,
      panels: [
        { id: 'p1', title: 'P1', description: '', plugin: 'x', link: '', refreshSeconds: 0 },
      ],
    };
  if (path.includes('/api/widgets/p1'))
    return {
      version: 1,
      id: 'p1',
      title: 'P1',
      status: 'ok',
      summary: 'All fine',
      stats: [],
      rows: [],
    };
  throw new Error(`unexpected ${path}`);
};

beforeEach(() => {
  settings.value = undefined;
  version = 4;
  stored = [svc('shared-one'), svc('shared-two')];
  allowed = true;
  readStatus = null;
  request.mockReset();
  clusterRequest.mockReset();
  request.mockImplementation(answer);
  clusterRequest.mockImplementation((path: string, init: any) => answer(path, init));
  clearClusterSources();
  clearPanelListCache();
});
afterEach(cleanup);

const settle = () =>
  act(async () => {
    await new Promise(r => setTimeout(r, 0));
  });

describe('cluster sources on the settings page', () => {
  it('shows the cluster sources as read-only rows with a Cluster badge and a Test button', async () => {
    render(wrap(<SourcesSettingsSection data={undefined} onChange={() => undefined} />));
    const row = await screen.findByText('Title shared-one');
    const card = row.closest('[data-cluster-source]') as HTMLElement;
    expect(within(card).getByText('Cluster')).toBeTruthy();
    expect(within(card).getByRole('button', { name: 'Test' })).toBeTruthy();
    expect(within(card).queryByRole('textbox')).toBeNull();
    expect(card.textContent).toContain('apps/shared-one:80');
    // The settings page names the cluster, because its URL has none.
    expect(clusterRequest).toHaveBeenCalled();
    expect(clusterRequest.mock.calls[0][1]).toMatchObject({ cluster: 'main' });
  });

  it('shows that a browser source overrides a cluster source', async () => {
    settings.value = { panelSources: [svc('shared-two', { namespace: 'mine' })] };
    render(wrap(<SourcesSettingsSection data={settings.value} onChange={() => undefined} />));
    await screen.findByText('Title shared-one');
    const cards = document.querySelectorAll('[data-cluster-source]');
    expect(cards[0].querySelector('[data-overridden]')).toBeNull();
    expect(cards[1].querySelector('[data-overridden]')?.textContent).toMatch(/overrides this one/);
    expect(document.querySelector('[data-override-note]')?.textContent).toMatch(
      /overrides the cluster source/
    );
  });

  it('saves edits with the resourceVersion for a user with write access', async () => {
    render(wrap(<SourcesSettingsSection data={undefined} onChange={() => undefined} />));
    await screen.findByText('Title shared-one');
    const edit = await screen.findByRole('button', { name: 'Edit cluster sources' });
    await waitFor(() => expect((edit as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(edit);
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getAllByRole('button', { name: 'Remove source' })[1]);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save to the cluster' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const put = clusterRequest.mock.calls.find(c => c[1]?.method === 'PUT');
    expect(put).toBeTruthy();
    expect(JSON.parse(put![1].body).metadata.resourceVersion).toBe('4');
    expect(stored.map(s => s.id)).toEqual(['shared-one']);
    await waitFor(() => expect(screen.queryByText('Title shared-two')).toBeNull());
  });

  it('shows the conflict message and keeps the dialog open', async () => {
    render(wrap(<SourcesSettingsSection data={undefined} onChange={() => undefined} />));
    await screen.findByText('Title shared-one');
    const edit = await screen.findByRole('button', { name: 'Edit cluster sources' });
    await waitFor(() => expect((edit as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(edit);
    version = 5; // someone else saved
    fireEvent.click(await screen.findByRole('button', { name: 'Save to the cluster' }));
    expect(await screen.findByText(/Someone else saved/)).toBeTruthy();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('keeps the edit action off and says why without write access', async () => {
    allowed = false;
    render(wrap(<SourcesSettingsSection data={undefined} onChange={() => undefined} />));
    await screen.findByText('Title shared-one');
    expect(await screen.findByText(/read-only access to the cluster sources/)).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Edit cluster sources' }) as HTMLButtonElement).disabled
    ).toBe(true);
  });

  it('shows a read error, and a note for a missing ConfigMap', async () => {
    readStatus = 403;
    render(wrap(<SourcesSettingsSection data={undefined} onChange={() => undefined} />));
    expect(await screen.findByText(/Could not read the cluster sources/)).toBeTruthy();
    cleanup();
    clearClusterSources();
    readStatus = null;
    request.mockImplementation(async (p: string, i: any) =>
      p.includes('/configmaps?') ? { items: [] } : answer(p, i)
    );
    clusterRequest.mockImplementation(async (p: string, i: any) =>
      p.includes('/configmaps?') ? { items: [] } : answer(p, i)
    );
    render(wrap(<SourcesSettingsSection data={undefined} onChange={() => undefined} />));
    expect(await screen.findByText(/There is no ConfigMap dashboard-sources/)).toBeTruthy();
  });

  it('shows the entries that were ignored', async () => {
    stored = [svc('good'), svc('bad', { namespace: '../x' })];
    render(wrap(<SourcesSettingsSection data={undefined} onChange={() => undefined} />));
    expect((await screen.findByText(/"bad" was ignored/)).textContent).toMatch(/namespace must/);
    expect(screen.getByText('Title good')).toBeTruthy();
  });
});

describe('cluster sources in widgets', () => {
  const props = (source: string) => ({
    id: 'w1',
    config: { source, panel: 'p1' },
    filters: { namespaces: [], nodes: [], labels: '' },
    refreshSignal: 0,
    reportRefreshed: vi.fn(),
    editing: false,
    kiosk: false,
    size: { w: 4, h: 8 },
    ...({} as object),
  });

  it('waits for the first read, then loads the panel from a cluster source', async () => {
    const view = render(wrap(<PanelWidget {...(props('shared-one') as any)} />));
    expect(screen.getByLabelText('Loading the panel')).toBeTruthy();
    expect(view.container.textContent).not.toMatch(/not configured/);
    await settle();
    await settle();
    expect(view.container.querySelector('[data-panel="p1"]')).not.toBeNull();
    const urls = request.mock.calls.map(c => String(c[0]));
    expect(urls.some(u => u.includes('/services/shared-one:80/proxy/api/widgets/p1'))).toBe(true);
  });

  it('reads the ConfigMap once for many widgets', async () => {
    render(
      wrap(
        <>
          {Array.from({ length: 8 }, (_, i) => (
            <PanelWidget key={i} {...(props('shared-one') as any)} />
          ))}
        </>
      )
    );
    await settle();
    await settle();
    const reads = request.mock.calls.filter(c => String(c[0]).includes('/configmaps?'));
    expect(reads).toHaveLength(1);
  });

  it('still says "not configured" for an id that no source has, after the read', async () => {
    const view = render(wrap(<PanelWidget {...(props('nope') as any)} />));
    await settle();
    await settle();
    expect(view.container.textContent).toMatch(/The source "nope" is not configured/);
  });

  it('offers a palette entry for a cluster source', async () => {
    let seen: string[] = [];
    function Probe() {
      seen = variantWidgets(useSources()).map(d => d.title);
      return null;
    }
    render(wrap(<Probe />));
    await settle();
    await settle();
    expect(seen).toEqual([
      'Panel from Title shared-one',
      'Sunburst from Title shared-one',
      'Panel from Title shared-two',
      'Sunburst from Title shared-two',
    ]);
  });
});
