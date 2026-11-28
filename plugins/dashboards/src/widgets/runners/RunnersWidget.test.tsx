/* The runner widget: which panels it fetches, and the title that starts the Nodes label. */
import { createTheme, ThemeProvider } from '@mui/material/styles';
import { cleanup, render } from '@testing-library/react';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@iconify/react', () => ({ Icon: () => null }));
vi.mock('@kinvolk/headlamp-plugin/lib', () => ({
  ApiProxy: { request: vi.fn(), clusterRequest: vi.fn() },
  ConfigStore: class {
    useConfig() {
      return () => undefined;
    }
  },
}));

const listed = vi.hoisted(() => ({ ids: [] as string[], title: '' as string }));
const fetched = vi.hoisted(() => ({ ids: [] as string[] }));

vi.mock('../panels/sourcesConfig', () => ({
  useSourceLookup: () => ({
    source: { id: 'runners', title: listed.title, kind: 'url', baseUrl: 'https://example.com' },
    pending: false,
  }),
  useSources: () => [],
}));
vi.mock('../panels/data', () => {
  const panel = (id: string, rows: unknown[]) => ({
    version: 1,
    id,
    title: id,
    status: 'ok',
    summary: '',
    rows,
    stats: [],
  });
  return {
    usePanelList: () => ({
      loading: false,
      error: null,
      panels: listed.ids.map(id => ({ id, refreshSeconds: 0 })),
    }),
    usePanel: (_s: unknown, id: string) => {
      if (id) fetched.ids.push(id);
      if (id === 'nodes') {
        const meta = { cpuBusy: '2.0', cpuAllocatable: '8.0', cpuSource: 'metrics-server' };
        return {
          loading: false,
          error: null,
          panel: panel('nodes', [{ label: 'worker-1', detail: '', value: '', status: 'ok', meta }]),
        };
      }
      return { loading: false, error: null, panel: id ? panel(id, []) : null };
    },
  };
});

import { runnersWidget } from './RunnersWidget';

const Widget = runnersWidget.Component;
const mount = () =>
  render(
    <ThemeProvider theme={createTheme({ palette: { mode: 'dark' } })}>
      <MemoryRouter initialEntries={['/dashboards/ops/overview']}>
        <Widget
          instanceId="w1"
          config={{ source: 'runners' }}
          filters={{} as never}
          refreshSignal={0}
          reportRefreshed={() => undefined}
          editing={false}
          kiosk={false}
        />
      </MemoryRouter>
    </ThemeProvider>
  );

beforeEach(() => {
  fetched.ids = [];
  listed.title = 'My runners';
});
afterEach(cleanup);

describe('RunnersWidget panels', () => {
  it('fetches the nodes panel only when the source lists it', () => {
    listed.ids = ['pools', 'queue'];
    mount();
    expect(fetched.ids).not.toContain('nodes');
    cleanup();
    fetched.ids = [];
    listed.ids = ['pools', 'queue', 'nodes'];
    mount();
    expect(fetched.ids).toContain('nodes');
  });

  it('starts the Nodes label with the title of the panel source', () => {
    listed.ids = ['pools', 'queue', 'nodes'];
    const { container } = mount();
    expect(container.querySelector('[data-runner-nodes-source]')?.textContent).toBe(
      'My runners, metrics-server'
    );
  });

  it('uses "Runner source" when the source has no title', () => {
    listed.ids = ['pools', 'queue', 'nodes'];
    listed.title = '';
    const { container } = mount();
    expect(container.querySelector('[data-runner-nodes-source]')?.textContent).toBe(
      'Runner source, metrics-server'
    );
  });
});
