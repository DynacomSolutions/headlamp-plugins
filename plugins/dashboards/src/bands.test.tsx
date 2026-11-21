/* The dashboard header and footer, the kiosk without its own clock, and the compact left tab rail. */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { MemoryRouter, Route, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@iconify/react', () => ({ Icon: (p: { icon: string }) => <i data-icon={p.icon} /> }));

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('@kinvolk/headlamp-plugin/lib', () => ({
  ApiProxy: { request },
  ConfigStore: class {
    useConfig() {
      return () => undefined;
    }
  },
}));
vi.mock('@kinvolk/headlamp-plugin/lib/CommonComponents', () => ({
  Loader: () => <div>loading</div>,
  SectionBox: (p: { children: React.ReactNode }) => <div>{p.children}</div>,
}));

import { HeaderPart,headerWidgets } from './components/HeaderStrip';
import { DashboardPage } from './DashboardPage';
import { getRegistry } from './registry';
import { addTab, addWidget } from './spec/edit';
import {
  BandShow,
  DashboardSpec,
  emptySpec,
  FOOTER_ID,
  HEADER_ID,
  SPEC_VERSION,
} from './spec/model';
import { DATA_KEY } from './storage/storage';
import { registerBuiltinWidgets } from './widgets/builtin';

(globalThis as any).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

let version = 1;
let spec: DashboardSpec = emptySpec('Ops');

const note = (text: string) => ({
  text,
  subtitle: '',
  style: 'both',
  size: 'medium',
  align: 'left',
});

/** Two tabs ("Overview" and "Nodes"), each with its own widget, a header with a clock and a footer. */
function build(patch: Partial<DashboardSpec> = {}, show: BandShow = 'both'): DashboardSpec {
  let s = emptySpec('Ops');
  const first = s.tabs[0];
  s = addWidget(
    s,
    first.id,
    first.sections[0].id,
    'core.header',
    { w: 12, h: 2 },
    note('Overview body')
  ).spec;
  const added = addTab(s, 'Nodes', 'mdi:server');
  s = added.spec;
  s = addWidget(
    s,
    added.tabId,
    s.tabs[1].sections[0].id,
    'core.header',
    { w: 12, h: 2 },
    note('Nodes body')
  ).spec;
  const clock = getRegistry().get('core.clock')!;
  s = addWidget(
    s,
    HEADER_ID,
    HEADER_ID,
    'core.clock',
    { w: 4, h: 3 },
    { ...clock.defaultConfig }
  ).spec;
  s = addWidget(s, FOOTER_ID, FOOTER_ID, 'core.header', { w: 12, h: 2 }, note('Footer text')).spec;
  s = {
    ...s,
    header: { ...s.header, show },
    footer: { ...s.footer, show },
    ...patch,
  };
  return s;
}

function configMap() {
  return {
    metadata: { name: 'ops', namespace: 'headlamp-dashboards', resourceVersion: String(version) },
    data: { [DATA_KEY]: JSON.stringify(spec) },
  };
}

const Where = () => {
  const l = useLocation();
  return <div data-testid="where">{l.pathname + l.search}</div>;
};

const mount = (url: string) =>
  render(
    <MemoryRouter initialEntries={[url]}>
      <Route path="/dashboards/:name/:tab?" component={DashboardPage} />
      <Where />
    </MemoryRouter>
  );

beforeEach(() => {
  registerBuiltinWidgets(getRegistry());
  version = 1;
  spec = build();
  request.mockReset();
  request.mockImplementation(async (path: string, params?: any) => {
    if (path.startsWith('/apis/authorization')) return { status: { allowed: true } };
    if (path.startsWith('/api/v1/namespaces/headlamp-dashboards/configmaps/ops')) {
      if (params?.method === 'PUT') {
        const body = JSON.parse(params.body);
        version += 1;
        spec = JSON.parse(body.data[DATA_KEY]);
      }
      return configMap();
    }
    return { items: [] };
  });
});

afterEach(cleanup);

const band = (key: 'header' | 'footer') =>
  document.querySelector(`[data-band="${key}"]`) as HTMLElement | null;

const titleBar = () => document.querySelector('[data-title-bar]') as HTMLElement;

describe('header and footer', () => {
  it('show on every tab, above and below the tab content, and stay when the tab changes', async () => {
    mount('/dashboards/ops');
    expect(await screen.findByText('Overview body')).toBeTruthy();
    const check = () => {
      const header = band('header')!;
      const footer = band('footer')!;
      expect(header.querySelector('[data-clock-widget]')).not.toBeNull();
      expect(within(footer).getByText('Footer text')).toBeTruthy();
      return { header, footer };
    };
    const first = check();
    const body = screen.getByText('Overview body');
    // Order in the page: header, content, footer.
    expect(
      first.header.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(
      body.compareDocumentPosition(first.footer) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: /Nodes/ }));
    expect(await screen.findByText('Nodes body')).toBeTruthy();
    expect(screen.queryByText('Overview body')).toBeNull();
    const second = check();
    // The same elements: the header is not drawn again for the new tab, so a clock keeps ticking.
    expect(second.header).toBe(first.header);
    expect(second.footer).toBe(first.footer);
  });

  it('draws nothing for an empty header and footer', async () => {
    spec = { ...emptySpec('Ops') };
    mount('/dashboards/ops');
    await screen.findByRole('heading', { name: 'Ops' });
    expect(band('header')).toBeNull();
    expect(band('footer')).toBeNull();
  });

  it('follows the show option in the normal view and in the kiosk', async () => {
    spec = build({}, 'normal');
    mount('/dashboards/ops');
    await screen.findByText('Overview body');
    expect(band('header')).not.toBeNull();
    cleanup();
    mount('/dashboards/ops?kiosk=1');
    await screen.findByText('Overview body');
    expect(band('header')).toBeNull();
    expect(band('footer')).toBeNull();
    cleanup();

    spec = build({}, 'kiosk');
    mount('/dashboards/ops');
    await screen.findByText('Overview body');
    expect(band('header')).toBeNull();
    cleanup();
    mount('/dashboards/ops?kiosk=1');
    await screen.findByText('Overview body');
    expect(band('header')).not.toBeNull();
    expect(band('footer')).not.toBeNull();
  });

  it('sticks to the top and the bottom only when the option is on', async () => {
    mount('/dashboards/ops');
    await screen.findByText('Overview body');
    expect(getComputedStyle(titleBar()).position).not.toBe('sticky');
    cleanup();

    const s = build();
    spec = { ...s, header: { ...s.header, sticky: true }, footer: { ...s.footer, sticky: true } };
    mount('/dashboards/ops');
    await screen.findByText('Overview body');
    const header = getComputedStyle(titleBar());
    const footer = getComputedStyle(band('footer')!);
    expect([header.position, header.top]).toEqual(['sticky', '0px']);
    expect([footer.position, footer.bottom]).toEqual(['sticky', '0px']);
  });

  it('shows in edit mode even when empty, with the sticky and show options, and saves them', async () => {
    spec = emptySpec('Ops');
    mount('/dashboards/ops?edit=1');
    await screen.findByRole('toolbar', { name: 'Edit tools' });
    expect(band('header')).not.toBeNull();
    expect(band('footer')).not.toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Sticky at the top' }));
    expect(screen.getByRole('checkbox', { name: 'Sticky at the bottom' })).toBeTruthy();
    expect(screen.getByLabelText('Show header in')).toBeTruthy();
    expect(screen.getByLabelText('Show footer in')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(version).toBe(2));
    expect(spec.header.sticky).toBe(true);
    expect(spec.footer.sticky).toBe(false);
    expect(spec.version).toBe(SPEC_VERSION);
  });

  it('lets a widget in the header open its settings in edit mode', async () => {
    mount('/dashboards/ops?edit=1');
    await screen.findByRole('toolbar', { name: 'Edit tools' });
    const header = band('header')!;
    const settings = within(header).getByLabelText(/^Settings for /);
    fireEvent.click(settings);
    expect(await screen.findByRole('dialog')).toBeTruthy();
  });
});

describe('one row header', () => {
  const order = (...els: Array<Element | null>) => {
    els.forEach(e => expect(e).not.toBeNull());
    for (let i = 0; i < els.length - 1; i++) {
      expect(els[i]!.compareDocumentPosition(els[i + 1]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING
      );
    }
  };

  it('draws the header widgets inline in the title bar, before the full screen button', async () => {
    mount('/dashboards/ops');
    await screen.findByText('Overview body');
    const bar = titleBar();
    const header = band('header')!;
    // The header is inside the title bar, not a band of its own above the tabs.
    expect(bar.contains(header)).toBe(true);
    expect(document.querySelectorAll('[data-band="header"]')).toHaveLength(1);
    order(
      within(bar).getByRole('heading', { name: 'Ops' }),
      within(bar).getByRole('search'),
      header.querySelector('[data-clock-widget]'),
      bar.querySelector('[data-last-refreshed]'),
      within(bar).getByRole('button', { name: 'Refresh now' }),
      within(bar).getByRole('button', { name: 'Full screen' })
    );
    // The row sits above the tabs and the content.
    order(bar, screen.getByText('Overview body'));
  });

  it('does the same in the kiosk: title, clock, then Refresh and Exit full screen', async () => {
    const { container } = mount('/dashboards/ops?kiosk=1');
    await screen.findByText('Overview body');
    const overlay = container.ownerDocument.querySelector('[data-kiosk-overlay]') as HTMLElement;
    const header = band('header')!;
    order(
      within(overlay).getByRole('heading', { name: 'Ops' }),
      header.querySelector('[data-clock-widget]'),
      overlay.querySelector('[data-last-refreshed]'),
      within(overlay).getByRole('button', { name: 'Refresh now' }),
      within(overlay).getByRole('button', { name: 'Exit full screen' })
    );
    // The bar and the exit button share one flex row, and the header is in that row.
    const row = within(overlay)
      .getByRole('button', { name: 'Exit full screen' })
      .closest('[data-title-bar]') as HTMLElement;
    expect(row.contains(header)).toBe(true);
    expect(row.contains(within(overlay).getByRole('heading', { name: 'Ops' }))).toBe(true);
  });

  it('keeps the row compact: no card, no card title and a stacked time and date', async () => {
    mount('/dashboards/ops');
    await screen.findByText('Overview body');
    const header = band('header')!;
    const clock = header.querySelector('[data-clock-widget]') as HTMLElement;
    expect(clock.hasAttribute('data-clock-compact')).toBe(true);
    expect(header.querySelector('.MuiPaper-root')).toBeNull();
    expect(within(header).queryByText('Clock')).toBeNull();
    expect(getComputedStyle(clock).flexDirection).toBe('column');
    const time = clock.querySelector('[data-clock-time]') as HTMLElement;
    const date = clock.querySelector('[data-clock-date]') as HTMLElement;
    expect(time.compareDocumentPosition(date) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Time (1.5 rem) plus date (0.75 rem) fit the 48 px row.
    expect(parseFloat(getComputedStyle(time).fontSize) * 1.1 + 12 * 1.2).toBeLessThanOrEqual(48);
    expect(getComputedStyle(header).display).toBe('flex');
  });

  it('wraps the title bar only through flex wrap', async () => {
    mount('/dashboards/ops');
    await screen.findByText('Overview body');
    expect(getComputedStyle(titleBar()).flexWrap).toBe('wrap');
  });

  it('keeps header widgets editable in edit mode', async () => {
    mount('/dashboards/ops?edit=1');
    await screen.findByRole('toolbar', { name: 'Edit tools' });
    expect(within(band('header')!).getByLabelText(/^Settings for /)).toBeTruthy();
    expect(within(band('header')!).getByLabelText(/^More actions for /)).toBeTruthy();
  });

  it('draws the full screen and refresh buttons as plain icons with the words in the tooltip', async () => {
    for (const url of ['/dashboards/ops', '/dashboards/ops?kiosk=1']) {
      mount(url);
      await screen.findByText('Overview body');
      const names = url.includes('kiosk')
        ? ['Refresh now', 'Exit full screen']
        : ['Refresh now', 'Full screen'];
      for (const name of names) {
        const btn = screen.getByRole('button', { name });
        // No text, an icon, no filled plate, no edge.
        expect(btn.textContent).toBe('');
        expect(btn.querySelector('[data-icon]')).not.toBeNull();
        expect(btn.className).toMatch(/MuiIconButton/);
        expect(btn.className).not.toMatch(/MuiButton-(outlined|contained)/);
        const css = getComputedStyle(btn);
        expect(['', 'transparent', 'rgba(0, 0, 0, 0)']).toContain(css.backgroundColor);
        expect(parseInt(css.borderWidth || '0', 10) || 0).toBe(0);
      }
      cleanup();
    }
  });

  it('puts the alert chips left, the clock in the middle and the rest right', () => {
    const w = (id: string, type: string, x: number) =>
      ({ id, type, title: '', config: {}, x, y: 0, w: 3, h: 3 } as any);
    const band = (widgets: any[]) =>
      ({ show: 'both', sticky: true, section: { id: '@header', widgets } } as any);
    const b = band([
      w('c', 'core.clock', 6),
      w('b', 'agent.alert-chips', 0),
      w('a', 'core.header', 10),
    ]);
    const ids = (part: HeaderPart) => headerWidgets(b, part).map(x => x.id);
    expect(ids('left')).toEqual(['b']);
    expect(ids('centre')).toEqual(['c']);
    expect(ids('right')).toEqual(['a']);
    // With no clock, every widget stays on the left.
    const none = band([w('b', 'agent.alert-chips', 0), w('a', 'core.header', 10)]);
    expect(headerWidgets(none, 'left').map(x => x.id)).toEqual(['b', 'a']);
    expect(headerWidgets(none, 'centre')).toEqual([]);
    expect(headerWidgets(none, 'right')).toEqual([]);
  });
});

describe('kiosk', () => {
  it('has no clock of its own: the clock is the widget in the header, on every tab', async () => {
    const { container } = mount('/dashboards/ops?kiosk=1');
    await screen.findByText('Overview body');
    const overlay = container.ownerDocument.querySelector('[data-kiosk-overlay]') as HTMLElement;
    expect(overlay).not.toBeNull();
    expect(overlay.querySelector('[data-kiosk-clock]')).toBeNull();
    // The only clock is the widget in the header.
    expect(overlay.querySelectorAll('[data-clock-widget]')).toHaveLength(1);
    expect(band('header')!.querySelector('[data-clock-widget]')).not.toBeNull();
    // The title, the refresh control and Exit stay.
    expect(within(overlay).getByRole('heading', { name: 'Ops' })).toBeTruthy();
    expect(within(overlay).getByRole('button', { name: 'Refresh now' })).toBeTruthy();
    expect(within(overlay).getByRole('button', { name: 'Exit full screen' })).toBeTruthy();

    fireEvent.click(within(overlay).getByRole('tab', { name: /Nodes/ }));
    await screen.findByText('Nodes body');
    expect(overlay.querySelectorAll('[data-clock-widget]')).toHaveLength(1);
    expect(band('header')!.querySelector('[data-clock-widget]')).not.toBeNull();
  });

  it('shows no clock at all when the header has none', async () => {
    spec = emptySpec('Ops');
    const { container } = mount('/dashboards/ops?kiosk=1');
    await screen.findByRole('heading', { name: 'Ops' });
    expect(container.ownerDocument.querySelector('[data-clock-time]')).toBeNull();
    expect(container.ownerDocument.querySelector('[data-kiosk-clock]')).toBeNull();
  });
});

describe('left tab rail', () => {
  const rail = () => document.querySelector('[data-tab-rail]') as HTMLElement | null;

  it('is compact by default on the left: a narrow rail, each tab an icon with its label under it', async () => {
    spec = build({ tabPosition: 'left' });
    mount('/dashboards/ops');
    await screen.findByText('Overview body');
    const r = rail()!;
    expect(r.getAttribute('data-tab-rail')).toBe('compact');
    const width = parseInt(getComputedStyle(r).width, 10);
    expect(width).toBeGreaterThanOrEqual(72);
    expect(width).toBeLessThanOrEqual(96);
    const tab = within(r).getByRole('tab', { name: 'Nodes' });
    // The icon first, the label under it.
    expect(getComputedStyle(tab).flexDirection).toBe('column');
    const children = Array.from(tab.children);
    expect(children[0].querySelector('[data-icon="mdi:server"]') ?? children[0]).toBeTruthy();
    expect(tab.querySelector('[data-icon="mdi:server"]')).not.toBeNull();
    expect(tab.textContent).toBe('Nodes');
    expect(tab.getAttribute('title')).toBe('Nodes');
    // The label comes after the icon in the document.
    const icon = tab.querySelector('[data-icon]')!;
    const label = Array.from(tab.querySelectorAll('span')).find(n => n.textContent === 'Nodes')!;
    expect(icon.compareDocumentPosition(label) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('keeps wide tabs when the rail style is wide', async () => {
    spec = build({ tabPosition: 'left', tabRail: 'wide' });
    mount('/dashboards/ops');
    await screen.findByText('Overview body');
    const r = rail()!;
    expect(r.getAttribute('data-tab-rail')).toBe('wide');
    expect(parseInt(getComputedStyle(r).minWidth, 10)).toBeGreaterThanOrEqual(160);
    expect(getComputedStyle(within(r).getByRole('tab', { name: /Nodes/ })).flexDirection).toBe(
      'row'
    );
  });

  it('leaves top tabs as they are', async () => {
    spec = build({ tabPosition: 'top' });
    mount('/dashboards/ops');
    await screen.findByText('Overview body');
    expect(rail()).toBeNull();
    expect(getComputedStyle(screen.getByRole('tab', { name: /Nodes/ })).flexDirection).toBe('row');
  });

  it('switches tab from the compact rail with a pushed path', async () => {
    spec = build({ tabPosition: 'left' });
    mount('/dashboards/ops');
    await screen.findByText('Overview body');
    fireEvent.click(screen.getByRole('tab', { name: 'Nodes' }));
    await waitFor(() =>
      expect(screen.getByTestId('where').textContent).toBe('/dashboards/ops/nodes')
    );
  });

  it('sets the rail style from the Tabs dialog and saves it', async () => {
    spec = build({ tabPosition: 'left' });
    mount('/dashboards/ops?edit=1');
    await screen.findByRole('toolbar', { name: 'Edit tools' });
    fireEvent.click(screen.getByRole('button', { name: 'Tabs' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Wide' }));
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(version).toBe(2));
    expect(spec.tabRail).toBe('wide');
  });
});
