import { createTheme, ThemeProvider } from '@mui/material/styles';
import { cleanup, render, waitFor } from '@testing-library/react';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { request, clusterRequest } = vi.hoisted(() => ({
  request: vi.fn(),
  clusterRequest: vi.fn(),
}));
vi.mock('@kinvolk/headlamp-plugin/lib', () => ({
  ApiProxy: { request, clusterRequest },
  ConfigStore: class {},
}));

import { parsePanel } from './model';
import { PanelView } from './PanelView';
import { clearIconCache } from './rowIcons';
import { blankDraft, draftToSource } from './sources';

const hoard = draftToSource({
  ...blankDraft('hoard'),
  namespace: 'hoarddb',
  service: 'hoarddb-widgets',
  port: '80',
});

const iconResponse = (type: string): Response =>
  ({
    ok: true,
    status: 200,
    headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? type : null) },
    arrayBuffer: () => Promise.resolve(new Uint8Array(8).buffer),
  } as unknown as Response);

const panel = (rows: unknown[]) => parsePanel({ version: 1, id: 'p', rows });
const ROWS = [
  {
    label: 'main',
    detail: 'a',
    value: '1',
    fraction: 0.4,
    status: 'ok',
    icon: { src: 'icons/postgresql.svg', alt: 'PostgreSQL' },
  },
  { label: 'other', detail: 'a', value: '2', fraction: 0.2, status: 'ok' },
  {
    label: 'third',
    detail: 'a',
    value: '3',
    fraction: 0.1,
    status: 'ok',
    icon: { src: 'icons/redis.png', alt: 'Redis' },
  },
];

const view = (
  rows: unknown[],
  opts: { layout?: 'list' | 'grouped-bars'; source?: typeof hoard; dark?: boolean } = {}
) =>
  render(
    <MemoryRouter>
      <ThemeProvider theme={createTheme({ palette: { mode: opts.dark ? 'dark' : 'light' } })}>
        <PanelView
          panel={panel(rows)}
          kiosk={!!opts.dark}
          editing={false}
          source={'source' in opts ? opts.source : hoard}
          display={{ showSummary: true, showStats: true, rowLayout: opts.layout ?? 'list' }}
        />
      </ThemeProvider>
    </MemoryRouter>
  );

beforeEach(() => {
  request.mockReset();
  let n = 0;
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => `blob:test/${++n}`),
    revokeObjectURL: vi.fn(),
  });
  clearIconCache();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe.each(['list', 'grouped-bars'] as const)('row icons in the %s layout', layout => {
  it('shows an img with the alt text, 20 px, before the label', async () => {
    request.mockResolvedValue(iconResponse('image/svg+xml'));
    const { container } = view(ROWS, { layout });
    await waitFor(() => expect(container.querySelectorAll('img[data-row-icon]')).toHaveLength(2));
    const imgs = Array.from(container.querySelectorAll('img[data-row-icon]'));
    expect(imgs.map(i => i.getAttribute('alt'))).toEqual(['PostgreSQL', 'Redis']);
    expect(imgs[0].getAttribute('src')).toMatch(/^blob:/);
    // Never inline markup.
    expect(container.querySelector('svg[data-row-icon]')).toBeNull();
    const sel = layout === 'list' ? '[data-row]' : '[data-bar-group]';
    const first = container.querySelector(sel)!;
    const kids = Array.from(first.querySelectorAll('[data-row-icon-slot], p, [data-bar-label]'));
    expect(kids[0].hasAttribute('data-row-icon-slot')).toBe(true);
  });
  it('reserves an empty slot for a row without an icon, so labels line up', async () => {
    request.mockResolvedValue(iconResponse('image/svg+xml'));
    const { container } = view(ROWS, { layout });
    await waitFor(() => expect(container.querySelectorAll('img[data-row-icon]')).toHaveLength(2));
    expect(container.querySelectorAll('[data-row-icon-slot]')).toHaveLength(3);
  });
  it('shows no slot and no img when no row has an icon', () => {
    const { container } = view(
      ROWS.map(r => ({ ...r, icon: undefined })),
      { layout }
    );
    expect(container.querySelector('[data-row-icon-slot]')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(request).not.toHaveBeenCalled();
  });
  it('shows no icon when the source is not known', () => {
    const { container } = view(ROWS, { layout, source: undefined });
    expect(container.querySelector('img')).toBeNull();
    expect(request).not.toHaveBeenCalled();
  });
  it('shows no img when the content type is wrong, and keeps the rows', async () => {
    request.mockResolvedValue(iconResponse('text/html'));
    const { container } = view(ROWS, { layout });
    await waitFor(() => expect(request).toHaveBeenCalled());
    await new Promise(r => setTimeout(r, 20));
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('main');
    expect(container.textContent).toContain('third');
  });
  it('works in the dark kiosk theme', async () => {
    request.mockResolvedValue(iconResponse('image/png'));
    const { container } = view(ROWS, { layout, dark: true });
    await waitFor(() => expect(container.querySelectorAll('img[data-row-icon]')).toHaveLength(2));
  });
});

describe('icon fetch from the view', () => {
  it('fetches each icon once, across two widgets and a re-render', async () => {
    request.mockResolvedValue(iconResponse('image/svg+xml'));
    const a = view(ROWS);
    const b = view(ROWS, { layout: 'grouped-bars' });
    await waitFor(() => expect(b.container.querySelectorAll('img[data-row-icon]')).toHaveLength(2));
    a.rerender(<div />);
    expect(request).toHaveBeenCalledTimes(2);
  });
});
