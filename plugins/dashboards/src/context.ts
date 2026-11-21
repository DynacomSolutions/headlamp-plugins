import React from 'react';
import type { DashboardFilters } from './contract';

/**
 * What every widget frame reads. It changes only on a filter change, a refresh or a mode
 * change, never on a layout change, so dragging one widget does not rerender the others.
 */
export interface DashboardContextValue {
  filters: DashboardFilters;
  refreshSignal: number;
  editing: boolean;
  kiosk: boolean;
  reportRefreshed: (at?: number) => void;
  /**
   * Where this dashboard keeps the last good data of its widgets: `<namespace>/<dashboard>`.
   * Absent: no widget cache (a test, or a page that is not a dashboard).
   */
  cacheScope?: string;
  /** A widget frame tells the header the time of the cached data that its widget shows. */
  reportCached?: (at: number) => void;
}

export const DashboardContext = React.createContext<DashboardContextValue | null>(null);

export function useDashboardContext(): DashboardContextValue {
  const ctx = React.useContext(DashboardContext);
  if (!ctx) throw new Error('useDashboardContext needs a DashboardContext provider.');
  return ctx;
}
