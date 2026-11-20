import { afterEach, describe, expect, it, vi } from 'vitest';
import { DASHBOARD_CONTRACT_VERSION, registerDashboardWidget, WidgetDefinition } from './contract';
import { createWidgetStore, installRegistry, validateDefinition } from './registry';

const def = (type: string, extra: Partial<WidgetDefinition> = {}): WidgetDefinition => ({
  type,
  title: type,
  icon: 'mdi:cube-outline',
  category: 'Other',
  defaultSize: { w: 2, h: 2 },
  defaultConfig: {},
  Component: () => null,
  ...extra,
});

afterEach(() => {
  delete window.headlampDashboards;
  vi.restoreAllMocks();
});

describe('validateDefinition', () => {
  it('accepts a complete definition and names the first problem otherwise', () => {
    expect(validateDefinition(def('a.b'))).toBeNull();
    expect(validateDefinition(def('Bad Type'))).toMatch(/type/);
    expect(validateDefinition(def('a', { title: '' }))).toMatch(/title/);
    expect(validateDefinition(def('a', { defaultSize: { w: 0, h: 1 } }))).toMatch(/defaultSize/);
    expect(validateDefinition(def('a', { Component: undefined as any }))).toMatch(/Component/);
  });
});

describe('widget store', () => {
  it('registers, replaces by type and notifies', () => {
    const store = createWidgetStore();
    const seen: number[] = [];
    store.subscribe(() => seen.push(store.getSnapshot()));
    store.registerWidget(def('a'));
    store.registerWidget(def('b'));
    store.registerWidget(def('a', { title: 'A2' }));
    expect(store.list().map(w => w.type)).toEqual(['a', 'b']);
    expect(store.get('a')?.title).toBe('A2');
    expect(seen).toEqual([1, 2, 3]);
  });

  it('ignores an invalid definition and logs it', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const store = createWidgetStore();
    store.registerWidget(def('Bad Type'));
    expect(store.list()).toEqual([]);
    expect(err).toHaveBeenCalled();
  });

  it('keeps the list identity until something registers', () => {
    const store = createWidgetStore();
    store.registerWidget(def('a'));
    expect(store.list()).toBe(store.list());
  });
});

describe('the global registry and its queue', () => {
  it('queues widgets that register before the Dashboards plugin loads', () => {
    expect(registerDashboardWidget(def('early.one'))).toBe(true);
    registerDashboardWidget(def('early.two'));
    const stub = window.headlampDashboards as any;
    expect(stub.stub).toBe(true);
    expect(stub.queue).toHaveLength(2);

    const store = installRegistry();
    expect(window.headlampDashboards).toBe(store);
    expect(store.list().map(w => w.type)).toEqual(['early.one', 'early.two']);
    expect(store.version).toBe(DASHBOARD_CONTRACT_VERSION);

    // After install, the helper registers straight into the store.
    registerDashboardWidget(def('late.one'));
    expect(store.get('late.one')).toBeDefined();
  });

  it('keeps an installed registry when the plugin code loads twice', () => {
    const first = installRegistry();
    first.registerWidget(def('a'));
    expect(installRegistry()).toBe(first);
    expect(first.get('a')).toBeDefined();
  });

  it('lets two copies of the helper share one queue', () => {
    registerDashboardWidget(def('p1.w'));
    registerDashboardWidget(def('p2.w'));
    expect((window.headlampDashboards as any).queue.map((w: WidgetDefinition) => w.type)).toEqual([
      'p1.w',
      'p2.w',
    ]);
  });
});
