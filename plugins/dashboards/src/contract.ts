/*
 * The widget contract of the Dashboards plugin.
 *
 * THIS FILE IS SELF-CONTAINED ON PURPOSE. Headlamp plugins are separate bundles, so a plugin
 * that supplies widgets cannot import from the Dashboards plugin. Copy this file into your
 * plugin (for example `src/dashboardsContract.ts`) and call `registerDashboardWidget(def)`.
 * It has no runtime dependency except `window`, and it only imports React types.
 *
 * How it works:
 *  - `window.headlampDashboards` is the global registry. The Dashboards plugin installs it.
 *  - A plugin may load before the Dashboards plugin. Then `registerDashboardWidget` puts a
 *    small stub on `window.headlampDashboards` and queues the definition. The Dashboards
 *    plugin replaces the stub and drains the queue when it loads.
 *  - Registering the same `type` twice replaces the first definition (the last one wins).
 *
 * Contract version: bump `DASHBOARD_CONTRACT_VERSION` only for a breaking change.
 */
import type React from 'react';

export const DASHBOARD_CONTRACT_VERSION = 1;

/** The time ranges the dashboard filter bar offers. Widgets map them to their own queries. */
export type TimeRange = '5m' | '15m' | '1h' | '6h' | '24h' | '7d' | '30d';

/**
 * The dashboard-level filter values. They go to every widget. A widget uses the ones that
 * make sense for it and ignores the rest. An empty list or string means "no filter".
 */
export interface DashboardFilters {
  /** Namespace names. Empty means all namespaces. */
  namespaces: string[];
  /** Node names. Empty means all nodes. */
  nodes: string[];
  /** A Kubernetes label selector such as `app=web,tier!=db`. Empty means no selector. */
  labelSelector: string;
  /** The time range for widgets that show history. */
  range: TimeRange;
}

/** A widget position and size in grid units (the grid has 12 columns and a fixed row height). */
export interface WidgetSize {
  w: number;
  h: number;
}

/** What the dashboard passes to a widget's `Component`. */
export interface WidgetProps<C = Record<string, unknown>> {
  /** Unique id of this widget on the dashboard. Stable across renders and saves. */
  instanceId: string;
  /** The widget's saved settings. Always merged over `defaultConfig`, so keys are present. */
  config: C;
  /** The dashboard filter values. A new object only when a filter changes. */
  filters: DashboardFilters;
  /**
   * A counter that goes up by one each time the dashboard asks for fresh data: the Refresh
   * button or the automatic interval. Fetch again when it changes. Fetch again when `filters`
   * changes too. It does not change when a user moves or resizes widgets.
   */
  refreshSignal: number;
  /**
   * Call this when your data has been fetched, with the fetch time in epoch milliseconds
   * (default: now). The header shows the latest time. The function is stable.
   */
  reportRefreshed: (at?: number) => void;
  /** True while the dashboard is in edit mode. Disable links and actions that leave the page. */
  editing: boolean;
  /** True in kiosk (full screen) mode: touch screen, no hover, no scrollbars. */
  kiosk: boolean;
  /**
   * True when the widget draws inline in the one row header of the title bar: no card, no title
   * row, and about 48 px of height. A widget that has no compact form can ignore it.
   */
  compact?: boolean;
}

/** What the dashboard passes to a widget's `SettingsComponent`. */
export interface WidgetSettingsProps<C = Record<string, unknown>> {
  /** The current draft settings. */
  config: C;
  /** Replace the whole draft. Call it with `{ ...config, key: value }`. */
  onChange: (config: C) => void;
}

/** One field of a generated settings form (use it instead of writing a `SettingsComponent`). */
export type ConfigField =
  | { key: string; label: string; type: 'text' | 'multiline'; help?: string; placeholder?: string }
  | {
      key: string;
      label: string;
      type: 'number';
      help?: string;
      min?: number;
      max?: number;
      step?: number;
    }
  | { key: string; label: string; type: 'boolean'; help?: string }
  | {
      key: string;
      label: string;
      type: 'select';
      help?: string;
      options: ReadonlyArray<{ value: string; label: string }>;
    };

/** Palette groups. Any other string is allowed and gets its own group. */
export const WIDGET_CATEGORIES = [
  'Text and layout',
  'Time',
  'Tables',
  'Charts',
  'Kubernetes',
  'Monitoring',
  'Other',
] as const;

export interface WidgetDefinition<C extends Record<string, any> = Record<string, any>> {
  /**
   * Unique type id, saved in the dashboard. Use `<plugin>.<widget>` in lower case, for
   * example `usage.donut`. Never rename it after release: saved dashboards use it.
   */
  type: string;
  /** Name shown in the palette and as the default widget title. */
  title: string;
  /** One sentence for the palette. */
  description?: string;
  /** An Iconify name, for example `mdi:clock-outline`. */
  icon: string;
  /** The palette group. Prefer one of `WIDGET_CATEGORIES`. */
  category: string;
  /** Size of a new widget, in grid units. */
  defaultSize: WidgetSize;
  /** The smallest size the user can resize to. Default 1 by 1. */
  minSize?: WidgetSize;
  /** The largest size the user can resize to. Default: unlimited. */
  maxSize?: WidgetSize;
  /** The settings of a new widget. Saved settings are merged over it, so new keys get defaults. */
  defaultConfig: C;
  /** A generated settings form. Ignored when `SettingsComponent` is set. */
  configSchema?: ConfigField[];
  /** A custom settings form, for settings a field list cannot describe. */
  SettingsComponent?: React.ComponentType<WidgetSettingsProps<C>>;
  /** The widget body. It fills its card: use `height: 100%`. Keep it pure and cheap to rerender. */
  Component: React.ComponentType<WidgetProps<C>>;
  /**
   * Whether the card content scrolls by default (for tables and lists). The user can change
   * it per widget with "Self-scroll content". Default false (content is clipped).
   */
  selfScroll?: boolean;
  /** Set to false for a widget with no card border and no title row (a header or a divider). */
  card?: boolean;
}

/** The registry the Dashboards plugin installs on `window.headlampDashboards`. */
export interface DashboardsRegistry {
  /** The contract version of the installed registry. */
  version: number;
  registerWidget(def: WidgetDefinition<any>): void;
}

/** The stub that exists before the Dashboards plugin loads. */
export interface DashboardsStub extends DashboardsRegistry {
  stub: true;
  queue: Array<WidgetDefinition<any>>;
}

declare global {
  interface Window {
    headlampDashboards?: DashboardsRegistry | DashboardsStub;
  }
}

/**
 * Register a widget type. Safe to call at any time, in any plugin load order. Returns false
 * when there is no `window` (a server-side run) so a caller can ignore it.
 */
export function registerDashboardWidget<C extends Record<string, any>>(
  def: WidgetDefinition<C>
): boolean {
  if (typeof window === 'undefined') return false;
  const existing = window.headlampDashboards;
  if (existing && typeof existing.registerWidget === 'function') {
    existing.registerWidget(def as WidgetDefinition<any>);
    return true;
  }
  const queue: Array<WidgetDefinition<any>> = [def as WidgetDefinition<any>];
  const stub: DashboardsStub = {
    stub: true,
    version: DASHBOARD_CONTRACT_VERSION,
    queue,
    registerWidget(d) {
      queue.push(d);
    },
  };
  window.headlampDashboards = stub;
  return true;
}
