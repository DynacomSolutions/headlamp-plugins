/*
 * The widget registry, on `window.headlampDashboards`. Other plugins are separate bundles and
 * cannot import this file, so they copy `contract.ts` and call `registerDashboardWidget`.
 * This module installs the real registry, takes over any stub that earlier plugins left,
 * and drains its queue. Registering a type twice replaces the first (the last one wins).
 */
import {
  DASHBOARD_CONTRACT_VERSION,
  DashboardsRegistry,
  DashboardsStub,
  WidgetDefinition,
} from './contract';

type Listener = () => void;

export interface WidgetStore extends DashboardsRegistry {
  get(type: string): WidgetDefinition | undefined;
  list(): WidgetDefinition[];
  /** For useSyncExternalStore. The snapshot changes only when a widget is registered. */
  subscribe(listener: Listener): () => void;
  getSnapshot(): number;
}

export function validateDefinition(def: WidgetDefinition<any>): string | null {
  if (!def || typeof def !== 'object') return 'A widget definition must be an object.';
  if (typeof def.type !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/.test(def.type)) {
    return 'A widget type must be lower case letters, digits, dots, dashes or underscores.';
  }
  if (typeof def.title !== 'string' || def.title === '')
    return `Widget ${def.type}: title is required.`;
  if (typeof def.icon !== 'string') return `Widget ${def.type}: icon is required.`;
  if (typeof def.category !== 'string') return `Widget ${def.type}: category is required.`;
  if (!def.defaultSize || !(def.defaultSize.w >= 1) || !(def.defaultSize.h >= 1)) {
    return `Widget ${def.type}: defaultSize needs w and h of at least 1.`;
  }
  if (!def.Component) return `Widget ${def.type}: Component is required.`;
  if (!def.defaultConfig || typeof def.defaultConfig !== 'object')
    return `Widget ${def.type}: defaultConfig is required.`;
  return null;
}

export function createWidgetStore(): WidgetStore {
  const widgets = new Map<string, WidgetDefinition>();
  const listeners = new Set<Listener>();
  let version = 0;
  let cached: WidgetDefinition[] = [];
  const store: WidgetStore = {
    version: DASHBOARD_CONTRACT_VERSION,
    registerWidget(def) {
      const problem = validateDefinition(def);
      if (problem) {
        // A bad definition from another plugin must not break the dashboards.
        console.error(`[dashboards] ${problem}`);
        return;
      }
      widgets.set(def.type, def);
      version += 1;
      cached = [...widgets.values()];
      listeners.forEach(l => l());
    },
    get: type => widgets.get(type),
    list: () => cached,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => version,
  };
  return store;
}

/**
 * Install the store on `win.headlampDashboards`, keeping an installed store (so a hot reload
 * keeps the registrations) and draining a stub's queue.
 */
export function installRegistry(win: Window & typeof globalThis = window): WidgetStore {
  const existing = win.headlampDashboards as
    | (Partial<WidgetStore> & Partial<DashboardsStub>)
    | undefined;
  if (
    existing &&
    !existing.stub &&
    typeof existing.get === 'function' &&
    typeof existing.subscribe === 'function'
  ) {
    return existing as WidgetStore;
  }
  const store = createWidgetStore();
  const queued = existing && existing.stub && Array.isArray(existing.queue) ? existing.queue : [];
  win.headlampDashboards = store;
  for (const def of queued) store.registerWidget(def);
  return store;
}

let shared: WidgetStore | undefined;
/** The plugin's own store, installed on first use. */
export function getRegistry(): WidgetStore {
  if (!shared || window.headlampDashboards !== shared) shared = installRegistry();
  return shared;
}
