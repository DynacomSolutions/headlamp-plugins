import { act, cleanup, render } from '@testing-library/react';
import React from 'react';
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

import { WidgetFrame } from '../components/WidgetFrame';
import { DashboardContext, DashboardContextValue } from '../context';
import { WidgetDefinition } from '../contract';
import { getRegistry } from '../registry';
import { defaultFilters } from '../spec/model';
import { useReportStale } from './stale';

afterEach(cleanup);

const ctx = (): DashboardContextValue => ({
  filters: defaultFilters(),
  refreshSignal: 0,
  editing: false,
  kiosk: true,
  reportRefreshed: () => undefined,
});
const actions = { menu: () => undefined, settings: () => undefined };

function register(type: string, card: boolean | undefined, since: { value?: number }) {
  const def: WidgetDefinition = {
    type,
    title: 'Probe',
    icon: 'mdi:cube-outline',
    category: 'Other',
    defaultSize: { w: 2, h: 2 },
    defaultConfig: {},
    card,
    Component: () => {
      useReportStale(since.value);
      return <span>body</span>;
    },
  };
  getRegistry().registerWidget(def);
}

const frame = (type: string) => (
  <DashboardContext.Provider value={ctx()}>
    <WidgetFrame
      sectionId="s"
      id="w1"
      type={type}
      title=""
      config={{}}
      selfScroll={undefined}
      actions={actions}
    />
  </DashboardContext.Provider>
);

describe('stale marker in the widget frame', () => {
  it('shows "Stale since HH:MM" in the card title row while a widget reports stale data, and clears it', () => {
    const since: { value?: number } = { value: new Date(2026, 10, 21, 17, 56, 30).getTime() };
    register('test.stale-card', undefined, since);
    const { container, rerender } = render(frame('test.stale-card'));
    expect(container.querySelector('[data-stale-since]')?.textContent).toBe('Stale since 17:56');
    since.value = undefined;
    rerender(<div>{frame('test.stale-card')}</div>);
    act(() => undefined);
    expect(container.querySelector('[data-stale-since]')).toBeNull();
  });

  it('shows the marker for a widget without a card too', () => {
    register('test.stale-plain', false, { value: new Date(2026, 10, 21, 9, 5).getTime() });
    const { container } = render(frame('test.stale-plain'));
    expect(container.querySelector('[data-stale-since]')?.textContent).toBe('Stale since 09:05');
  });

  it('shows nothing for a widget with fresh data', () => {
    register('test.fresh', undefined, {});
    const { container } = render(frame('test.fresh'));
    expect(container.querySelector('[data-stale-since]')).toBeNull();
  });

  it('is a no-op outside a frame', () => {
    const C = () => {
      useReportStale(123);
      return <span>x</span>;
    };
    expect(render(<C />).container.textContent).toBe('x');
  });
});
