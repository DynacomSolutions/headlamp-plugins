import { act, cleanup, fireEvent, render } from '@testing-library/react';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@iconify/react', () => ({ Icon: (p: { icon: string }) => <i data-icon={p.icon} /> }));
vi.mock('@kinvolk/headlamp-plugin/lib', () => ({
  ApiProxy: { request: vi.fn() },
  ConfigStore: class {
    useConfig() {
      return () => undefined;
    }
  },
}));

import { PlaceholderWidget } from '../components/PlaceholderWidget';
import { WidgetFrame } from '../components/WidgetFrame';
import { DashboardContext, DashboardContextValue } from '../context';
import { WidgetDefinition } from '../contract';
import { LinkContext } from '../links';
import { getRegistry } from '../registry';
import { defaultFilters } from '../spec/model';
import { DEFAULT_CLOCK } from './clockFormat';
import { ClockView, useTick } from './ClockWidget';
import { WidgetFooter } from './footer';
import { HeaderView } from './HeaderWidget';
import { NoteView, safeHref } from './NoteWidget';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('clock widget', () => {
  const now = new Date(Date.UTC(2026, 10, 19, 14, 5, 9));
  it('shows the time and the date in the chosen zone', () => {
    const { container } = render(
      <ClockView now={now} config={{ ...DEFAULT_CLOCK, timeZone: 'UTC', showSeconds: true }} />
    );
    expect(container.querySelector('[data-clock-time]')?.textContent).toBe('14:05:09');
    expect(container.querySelector('[data-clock-date]')?.textContent).toBe('Thu 19 Nov 2026');
    expect(container.querySelector('[data-clock-zone]')).toBeNull();
  });
  it('draws the compact clock larger in full screen than in the page', () => {
    const size = (kiosk: boolean) => {
      const { container, unmount } = render(
        <ClockView now={now} config={{ ...DEFAULT_CLOCK, timeZone: 'UTC' }} compact kiosk={kiosk} />
      );
      const px = getComputedStyle(container.querySelector('[data-clock-time]') as Element).fontSize;
      unmount();
      return px;
    };
    expect(size(true)).toBe('2.875rem');
    expect(size(false)).toBe('1.5rem');
  });
  it('hides the date and shows the zone name when asked', () => {
    const { container } = render(
      <ClockView
        now={now}
        config={{ ...DEFAULT_CLOCK, timeZone: 'Asia/Bangkok', showDate: false, showZone: true }}
      />
    );
    expect(container.querySelector('[data-clock-date]')).toBeNull();
    expect(container.querySelector('[data-clock-time]')?.textContent).toBe('21:05');
    expect(container.querySelector('[data-clock-zone]')?.textContent).toBe('Asia/Bangkok');
  });
  it('ticks on its own', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 1, 10, 0, 0, 500));
    const seen: number[] = [];
    function Probe() {
      seen.push(useTick(1000).getSeconds());
      return null;
    }
    render(<Probe />);
    act(() => {
      vi.advanceTimersByTime(2100);
    });
    expect(new Set(seen).size).toBeGreaterThan(1);
  });
});

describe('note widget', () => {
  it('renders Markdown and does not run HTML', () => {
    const { container } = render(
      <MemoryRouter initialEntries={['/dashboards/ops?kiosk=1']}>
        <LinkContext.Provider value={{ base: '', dashboard: 'ops', tabs: ['hoarddb'] }}>
        <NoteView
          config={{
            markdown:
              '# Title\n\n**bold** <script>x</script> [ok](/dashboards/ops/hoarddb) [page](/c/main/nodes) [web](https://example.com) [bad](javascript:alert(1))',
            align: 'left',
          }}
        />
        </LinkContext.Provider>
      </MemoryRouter>
    );
    expect(container.querySelector('h2')?.textContent).toBe('Title');
    expect(container.querySelector('strong')?.textContent).toBe('bold');
    expect(container.querySelector('script')).toBeNull();
    // Only the path of this dashboard is a link, and it keeps the query. The web address, the script
    // address and the path of another Headlamp page are plain text.
    const links = Array.from(container.querySelectorAll('a'));
    expect(links.map(a => a.getAttribute('href'))).toEqual(['/dashboards/ops/hoarddb?kiosk=1']);
    expect(links.some(a => a.getAttribute('target') === '_blank')).toBe(false);
    expect(container.textContent).toContain('web');
    expect(container.textContent).toContain('page');
  });
  it('shows a hint for an empty note', () => {
    const { container } = render(<NoteView config={{ markdown: '  ', align: 'left' }} />);
    expect(container.textContent).toMatch(/Empty note/);
  });
  it('follows paths inside Headlamp only', () => {
    expect(safeHref('/dashboards')).toBeDefined();
    expect(safeHref('https://a.example.com')).toBeUndefined();
    expect(safeHref('mailto:a@example.com')).toBeUndefined();
    expect(safeHref('//a.example.com')).toBeUndefined();
    expect(safeHref('javascript:alert(1)')).toBeUndefined();
    expect(safeHref('data:text/html,x')).toBeUndefined();
    expect(safeHref(undefined)).toBeUndefined();
  });
});

describe('header widget', () => {
  const cfg = {
    text: 'Heading',
    subtitle: 'Sub',
    style: 'both',
    size: 'medium',
    align: 'left',
  } as const;
  it('shows text and a line, or only one of them', () => {
    const both = render(<HeaderView config={cfg} />);
    expect(both.container.textContent).toContain('Heading');
    expect(both.container.querySelector('hr')).not.toBeNull();
    both.unmount();
    const line = render(<HeaderView config={{ ...cfg, style: 'divider' }} />);
    expect(line.container.textContent).toBe('');
    expect(line.container.querySelector('hr')).not.toBeNull();
    line.unmount();
    const text = render(<HeaderView config={{ ...cfg, style: 'header' }} />);
    expect(text.container.querySelector('hr')).toBeNull();
  });
});

describe('unknown widget type', () => {
  it('shows a placeholder card with the type', () => {
    const { container } = render(<PlaceholderWidget type="missing.thing" />);
    expect(container.querySelector('[data-widget-placeholder]')).not.toBeNull();
    expect(container.textContent).toContain('missing.thing');
    expect(container.textContent).toContain('not installed');
  });
});

describe('widget frame', () => {
  const ctxValue = (over: Partial<DashboardContextValue> = {}): DashboardContextValue => ({
    filters: defaultFilters(),
    refreshSignal: 0,
    editing: false,
    kiosk: false,
    reportRefreshed: () => undefined,
    ...over,
  });
  const actions = { menu: vi.fn(), settings: vi.fn() };

  it('renders a placeholder for an unregistered type', () => {
    const { container } = render(
      <DashboardContext.Provider value={ctxValue()}>
        <WidgetFrame
          sectionId="s"
          id="w1"
          type="nobody.registered"
          title=""
          config={{}}
          selfScroll={undefined}
          actions={actions}
        />
      </DashboardContext.Provider>
    );
    expect(container.querySelector('[data-widget-placeholder]')).not.toBeNull();
  });

  it('draws the title on the box edge and a footer that a widget fills with its summary', () => {
    const def: WidgetDefinition = {
      type: 'test.footer',
      title: 'Footer probe',
      icon: 'mdi:cube-outline',
      category: 'Other',
      defaultSize: { w: 2, h: 2 },
      defaultConfig: {},
      Component: p => (
        <WidgetFooter status="warn" footer={p.footer}>
          3 warnings
        </WidgetFooter>
      ),
    };
    getRegistry().registerWidget(def);
    const { container } = render(
      <DashboardContext.Provider value={ctxValue()}>
        <WidgetFrame
          sectionId="s"
          id="w1"
          type="test.footer"
          title=""
          config={{}}
          selfScroll={undefined}
          actions={actions}
        />
      </DashboardContext.Provider>
    );
    const legend = container.querySelector('[data-widget-legend]') as HTMLElement;
    expect(legend.textContent).toContain('Footer probe');
    expect(legend.style.top || getComputedStyle(legend).top).toBe('-12px');
    const footer = container.querySelector('[data-widget-footer]') as HTMLElement;
    expect(footer.textContent).toBe('3 warnings');
    expect(footer.querySelector('svg[aria-label="Warning"]')).not.toBeNull();
    // The summary is in the footer, not in the body.
    expect(container.querySelectorAll('[data-widget-summary]')).toHaveLength(1);
  });

  it('passes config merged over defaults, the filters, the signal and the report callback to a widget', () => {
    const seen: any[] = [];
    const def: WidgetDefinition = {
      type: 'test.probe',
      title: 'Probe',
      icon: 'mdi:cube-outline',
      category: 'Other',
      defaultSize: { w: 2, h: 2 },
      defaultConfig: { a: 1, b: 2 },
      Component: p => {
        seen.push(p);
        return <span>probe</span>;
      },
    };
    getRegistry().registerWidget(def);
    const report = vi.fn();
    const { container, rerender } = render(
      <DashboardContext.Provider value={ctxValue({ reportRefreshed: report, refreshSignal: 3 })}>
        <WidgetFrame
          sectionId="s"
          id="w1"
          type="test.probe"
          title=""
          config={{ b: 9 }}
          selfScroll={undefined}
          actions={actions}
        />
      </DashboardContext.Provider>
    );
    expect(container.textContent).toContain('Probe');
    const props = seen[seen.length - 1];
    expect(props).toMatchObject({
      instanceId: 'w1',
      config: { a: 1, b: 9 },
      refreshSignal: 3,
      editing: false,
      kiosk: false,
    });
    props.reportRefreshed(5);
    expect(report).toHaveBeenCalledWith(5);
    rerender(<span />);
  });

  it('does not rerender a widget when its props and the context are unchanged', () => {
    let renders = 0;
    getRegistry().registerWidget({
      type: 'test.count',
      title: 'Count',
      icon: 'mdi:cube-outline',
      category: 'Other',
      defaultSize: { w: 2, h: 2 },
      defaultConfig: {},
      Component: () => {
        renders += 1;
        return null;
      },
    });
    const value = ctxValue();
    const config = {};
    const tree = (title: string) => (
      <DashboardContext.Provider value={value}>
        <WidgetFrame
          sectionId="s"
          id="w1"
          type="test.count"
          title={title}
          config={config}
          selfScroll={undefined}
          actions={actions}
        />
      </DashboardContext.Provider>
    );
    const { rerender } = render(tree(''));
    const first = renders;
    // A parent rerender with the same props (what a layout change causes for the others) is skipped.
    rerender(tree(''));
    rerender(tree(''));
    expect(renders).toBe(first);
    // A refresh signal change reaches the widget.
    const next = ctxValue({ refreshSignal: 1 });
    rerender(
      <DashboardContext.Provider value={next}>
        <WidgetFrame
          sectionId="s"
          id="w1"
          type="test.count"
          title=""
          config={config}
          selfScroll={undefined}
          actions={actions}
        />
      </DashboardContext.Provider>
    );
    expect(renders).toBeGreaterThan(first);
  });

  it('gives a failed widget a new try when its config changes', () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    getRegistry().registerWidget({
      type: 'test.fragile',
      title: 'Fragile',
      icon: 'mdi:cube-outline',
      category: 'Other',
      defaultSize: { w: 2, h: 2 },
      defaultConfig: {},
      Component: ({ config }) => {
        if (config.broken) throw new Error('bad config');
        return <span>works</span>;
      },
    });
    const value = ctxValue();
    const tree = (id: string, config: Record<string, unknown>) => (
      <DashboardContext.Provider value={value}>
        <WidgetFrame
          sectionId="s"
          id={id}
          type="test.fragile"
          title=""
          config={config}
          selfScroll={undefined}
          actions={actions}
        />
      </DashboardContext.Provider>
    );
    const { container, rerender } = render(tree('w1', { broken: true }));
    expect(container.textContent).toContain('This widget failed: bad config');
    // The same config stays failed.
    rerender(tree('w1', { broken: true }));
    expect(container.textContent).toContain('This widget failed');
    // A new config (the user fixed the settings) gets a new try.
    rerender(tree('w1', { broken: false }));
    expect(container.textContent).toContain('works');
    expect(container.textContent).not.toContain('This widget failed');
    quiet.mockRestore();
  });

  it('shows the edit controls only in edit mode and calls the actions', () => {
    const a = { menu: vi.fn(), settings: vi.fn() };
    const view = render(
      <DashboardContext.Provider value={ctxValue()}>
        <WidgetFrame
          sectionId="s"
          id="w1"
          type="test.count"
          title="T"
          config={{}}
          selfScroll={undefined}
          actions={a}
        />
      </DashboardContext.Provider>
    );
    expect(view.queryByLabelText('Settings for T')).toBeNull();
    view.unmount();
    const edit = render(
      <DashboardContext.Provider value={ctxValue({ editing: true })}>
        <WidgetFrame
          sectionId="s"
          id="w1"
          type="test.count"
          title="T"
          config={{}}
          selfScroll={undefined}
          actions={a}
        />
      </DashboardContext.Provider>
    );
    fireEvent.click(edit.getByLabelText('Settings for T'));
    expect(a.settings).toHaveBeenCalledWith('s', 'w1');
    fireEvent.click(edit.getByLabelText('More actions for T'));
    expect(a.menu).toHaveBeenCalledWith(expect.any(HTMLElement), 's', 'w1');
  });
});
