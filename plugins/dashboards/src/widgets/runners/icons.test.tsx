import { createTheme, ThemeProvider } from '@mui/material/styles';
import { cleanup, render, waitFor } from '@testing-library/react';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const request = vi.hoisted(() => vi.fn());
vi.mock('@kinvolk/headlamp-plugin/lib', () => ({
  ApiProxy: { request, clusterRequest: vi.fn() },
  ConfigStore: class {
    useConfig() {
      return () => undefined;
    }
  },
}));

import { LinkContext } from '../../links';
import { parsePanel } from '../panels/model';
import { DEFAULT_DISPLAY, PanelView } from '../panels/PanelView';
import {
  clearIconMapCache,
  fetchIconMap,
  ICON_CACHE_MS,
  ICON_MAP_VALUE_MAX,
  iconForLabel,
  iconMapFrom,
  mapIconFor,
  orgIconFor,
  orgIconKey,
  repoIconFor,
  repoIconKey,
} from './icons';
import { joinRunners } from './join';
import { resetRunnerFolds, RunnersView } from './RunnersView';

const PNG = 'data:image/png;base64,AAAA';
const SVG = 'data:image/svg+xml;base64,BBBB';
const MAP = new Map<string, string>([
  ['gh.acme', PNG],
  ['gh.acme.web', SVG],
  ['api', SVG],
  ['gh.other', PNG],
]);

beforeEach(() => {
  clearIconMapCache();
  request.mockReset();
});
afterEach(() => {
  cleanup();
  resetRunnerFolds();
});

describe('the icon map', () => {
  it('keeps only small SVG and PNG data addresses, with lower-case keys', () => {
    const map = iconMapFrom({
      data: {
        'GH.Acme': ` ${PNG} `,
        bad: 'https://example.com/x.png',
        huge: `data:image/png;base64,${'A'.repeat(ICON_MAP_VALUE_MAX)}`,
        gif: 'data:image/gif;base64,AAAA',
        num: 5,
      },
    });
    expect([...map.keys()]).toEqual(['gh.acme']);
    expect(map.get('gh.acme')).toBe(PNG);
  });

  it('gives an empty map for a missing or wrong ConfigMap', () => {
    expect(iconMapFrom(null).size).toBe(0);
    expect(iconMapFrom({}).size).toBe(0);
    expect(iconMapFrom({ data: 'x' }).size).toBe(0);
  });

  it('builds the keys of an org and a repo in lower case', () => {
    expect(orgIconKey(' Acme ')).toBe('gh.acme');
    expect(repoIconKey('Acme', '.Cluster')).toBe('gh.acme..cluster');
  });
});

describe('the icon of an org and of a repo', () => {
  it('gives the avatar of an org, and none for an org that is not in the map', () => {
    expect(orgIconFor('acme', MAP)).toBe(PNG);
    expect(orgIconFor('Acme', MAP)).toBe(PNG);
    expect(orgIconFor('nobody', MAP)).toBeUndefined();
    expect(orgIconFor('No org', MAP)).toBeUndefined();
  });

  it('gives a repo its own icon first', () => {
    expect(repoIconFor('acme', 'web', MAP)).toBe(SVG);
  });

  it('falls back to an app icon with the repo name, then to the org avatar', () => {
    expect(repoIconFor('acme', 'api', MAP)).toBe(SVG);
    expect(repoIconFor('acme', 'api-preview', MAP)).toBe(SVG);
    expect(repoIconFor('acme', 'docs', MAP)).toBe(PNG);
  });

  it('never draws a made-up icon: no map entry means no icon', () => {
    expect(repoIconFor('nobody', 'docs', MAP)).toBeUndefined();
    expect(repoIconFor('nobody', 'docs', new Map())).toBeUndefined();
  });

  it('gives a repo that the source does not know only the org avatar', () => {
    expect(repoIconFor('acme', 'Repo not known', MAP)).toBe(PNG);
    expect(repoIconFor('No org', 'web', MAP)).toBeUndefined();
  });

  it('never matches a runner key as an app key', () => {
    expect(mapIconFor('gh', MAP)).toBeUndefined();
    expect(mapIconFor('gh.acme', new Map([['gh.acme', PNG]]))).toBe(PNG);
    expect(mapIconFor('gh.acme-x', new Map([['gh.acme', PNG]]))).toBeUndefined();
    expect(mapIconFor('', MAP)).toBeUndefined();
  });
});

describe('reading the icon map', () => {
  const body = { data: { 'gh.acme': PNG } };

  it('reads the ConfigMap once for a minute and shares it', async () => {
    request.mockResolvedValue(body);
    const a = await fetchIconMap(1000);
    const b = await fetchIconMap(1000 + ICON_CACHE_MS - 1);
    expect(a.get('gh.acme')).toBe(PNG);
    expect(b).toBe(a);
    // One read for each of the two ConfigMaps.
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls.map(c => c[0]).sort()).toEqual([
      '/api/v1/namespaces/headlamp-dashboards/configmaps/runner-icons',
      '/api/v1/namespaces/headlamp-dashboards/configmaps/uptime-icons',
    ]);
    await fetchIconMap(1000 + ICON_CACHE_MS);
    expect(request).toHaveBeenCalledTimes(4);
  });

  it('gives an empty map when the read fails, and reads again after a failure other than 404', async () => {
    request.mockRejectedValueOnce({ status: 500 });
    expect((await fetchIconMap(1)).size).toBe(0);
    request.mockResolvedValueOnce(body);
    expect((await fetchIconMap(2)).size).toBe(1);
  });

  it('keeps an absent map (404) for the minute', async () => {
    request.mockRejectedValue({ status: 404 });
    expect((await fetchIconMap(1)).size).toBe(0);
    expect((await fetchIconMap(2)).size).toBe(0);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('merges the app icons of the Uptime map with the runner map, and the runner key wins', async () => {
    request.mockImplementation(async (path: string) =>
      path.endsWith('/runner-icons')
        ? { data: { 'gh.acme': PNG, shared: PNG } }
        : { data: { api: SVG, shared: SVG } }
    );
    const map = await fetchIconMap(5);
    expect(map.get('gh.acme')).toBe(PNG);
    expect(map.get('api')).toBe(SVG);
    expect(map.get('shared')).toBe(PNG);
  });

  it('keeps the runner icons when the Uptime map is absent', async () => {
    request.mockImplementation(async (path: string) => {
      if (path.endsWith('/uptime-icons')) throw { status: 404 };
      return { data: { 'gh.acme': PNG } };
    });
    expect((await fetchIconMap(9)).get('gh.acme')).toBe(PNG);
  });
});

const run = (id: string, repo: string, state: string, seconds: number, repoKnown = true) => ({
  id,
  repo,
  repoKnown,
  workflow: `wf-${id}`,
  ref: 'main',
  pool: 'pool-a',
  state,
  seconds,
  counts: state === 'running' ? { running: 1, queued: 0 } : { running: 0, queued: 1 },
  jobs: [],
});
const runs = parsePanel({
  version: 1,
  id: 'runs',
  title: 'Runs',
  status: 'ok',
  summary: '',
  runs: [
    run('r1', 'acme/web', 'running', 30),
    run('r2', 'acme/docs', 'running', 20),
    run('r3', 'nobody/tool', 'queued', 5),
    run('r4', 'acme', 'queued', 4, false),
  ],
});

const draw = () =>
  render(
    <ThemeProvider theme={createTheme({ palette: { mode: 'dark' } })}>
      <MemoryRouter>
        <LinkContext.Provider value={{ base: '/c/main', dashboard: 'ops', tabs: ['runners'] }}>
          <RunnersView
            model={joinRunners({ pools: null, queue: null, runs })}
            sourceId="runners"
            editing={false}
            expand="all"
          />
        </LinkContext.Provider>
      </MemoryRouter>
    </ThemeProvider>
  );

describe('the icons in the runner list', () => {
  it('shows no icon and no slot when the map has none', async () => {
    request.mockResolvedValue({ data: {} });
    const { container } = draw();
    await waitFor(() => expect(request).toHaveBeenCalled());
    expect(container.querySelector('[data-group-icon-slot]')).toBeNull();
    expect(container.querySelector('[data-group-icon]')).toBeNull();
  });

  it('shows the org avatar on an org, and the own icon, then the avatar, on a repo', async () => {
    request.mockResolvedValue({ data: { 'gh.acme': PNG, 'gh.acme.web': SVG } });
    const { container } = draw();
    const icon = (key: string) =>
      container.querySelector(`[data-group-key="${key}"] [data-group-icon]`)?.getAttribute('src');
    await waitFor(() => expect(icon('acme')).toBe(PNG));
    expect(icon('acme/web')).toBe(SVG);
    expect(icon('acme/docs')).toBe(PNG);
    expect(icon('acme/Repo not known')).toBe(PNG);
  });

  it('keeps the names aligned: an org with no avatar has an empty slot of the same size', async () => {
    request.mockResolvedValue({ data: { 'gh.acme': PNG } });
    const { container } = draw();
    await waitFor(() =>
      expect(container.querySelector('[data-group-key="acme"] [data-group-icon]')).not.toBeNull()
    );
    const none = container.querySelector('[data-group-key="nobody"]')!;
    expect(none.querySelector('[data-group-icon-slot]')).not.toBeNull();
    expect(none.querySelector('[data-group-icon]')).toBeNull();
    expect(none.querySelector('[data-group-icon-slot]')?.children).toHaveLength(0);
  });

  it('uses no external address: every icon is a data address from the map', async () => {
    request.mockResolvedValue({
      data: { 'gh.acme': PNG, 'gh.nobody': 'https://example.com/a.png' },
    });
    const { container } = draw();
    await waitFor(() => expect(container.querySelector('[data-group-icon]')).not.toBeNull());
    for (const img of container.querySelectorAll('[data-group-icon]')) {
      expect(img.getAttribute('src')).toMatch(/^data:image\/(png|svg\+xml);/);
    }
  });
});

describe('the icon of an org/repo label', () => {
  it('gives the repo icon, else the org avatar, and none for other labels', () => {
    expect(iconForLabel('acme/web', MAP)).toBe(SVG);
    expect(iconForLabel('acme/docs', MAP)).toBe(PNG);
    expect(iconForLabel('nobody/docs', MAP)).toBeUndefined();
    expect(iconForLabel('pool-linux', MAP)).toBeUndefined();
    expect(iconForLabel('acme/web 12 failed', MAP)).toBeUndefined();
    expect(iconForLabel('', MAP)).toBeUndefined();
  });
});

describe('the icons in a panel list', () => {
  const panel = parsePanel({
    version: 1,
    id: 'failures',
    title: 'Failures',
    status: 'ok',
    summary: '',
    rows: [
      { label: 'acme/web', detail: '1 failed', value: '5%', status: 'warn' },
      { label: 'acme/docs', detail: '0 failed', value: '0%', status: 'ok' },
      { label: 'nobody/tool', detail: '0 failed', value: '0%', status: 'ok' },
    ],
  });
  const draw = (orgIcons: boolean) =>
    render(
      <ThemeProvider theme={createTheme({ palette: { mode: 'dark' } })}>
        <MemoryRouter>
          <PanelView
            panel={panel}
            kiosk={false}
            editing={false}
            display={{ ...DEFAULT_DISPLAY, orgIcons }}
          />
        </MemoryRouter>
      </ThemeProvider>
    ).container;

  it('shows the repo icon or the org avatar on each row, and an empty slot when there is none', async () => {
    request.mockResolvedValue({ data: { 'gh.acme': PNG, 'gh.acme.web': SVG } });
    const c = draw(true);
    const src = (i: number) =>
      c.querySelectorAll('[data-row]')[i]?.querySelector('[data-group-icon]')?.getAttribute('src');
    await waitFor(() => expect(c.querySelector('[data-group-icon]')).not.toBeNull());
    // The rows come worst first: acme/web (warn), then acme/docs, then nobody/tool.
    expect(src(0)).toBe(SVG);
    expect(src(1)).toBe(PNG);
    expect(src(2)).toBeUndefined();
    expect(c.querySelectorAll('[data-row] [data-group-icon-slot]')).toHaveLength(3);
  });

  it('shows no icon, and reads no map, when the option is off', async () => {
    request.mockResolvedValue({ data: { 'gh.acme': PNG } });
    const c = draw(false);
    await Promise.resolve();
    expect(request).not.toHaveBeenCalled();
    expect(c.querySelector('[data-group-icon-slot]')).toBeNull();
  });
});
