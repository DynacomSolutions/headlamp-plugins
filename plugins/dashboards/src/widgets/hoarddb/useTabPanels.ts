/*
 * Fetches the panels that a HoardDB tab widget reads. Each panel is fetched like the panel widget
 * does it, never sooner than the panel's own `refreshSeconds`. The widgets of one tab ask for the
 * same addresses, and the fetch layer shares those requests, so a second widget costs no call.
 */
import { useReportStale } from '../../resilience/stale';
import { type PanelState, usePanel, usePanelList } from '../panels/data';
import type { PanelSource } from '../panels/sources';
import { useSourceLookup } from '../panels/sourcesConfig';
import type { TabPanelId, TabPanels } from './tab';

export interface TabPanelsState {
  panels: TabPanels;
  states: PanelState[];
  source: PanelSource | undefined;
  loading: boolean;
  /** The first error, when any panel failed. */
  error: string | null;
  /** True when no panel has data. */
  none: boolean;
}

export function useTabPanels(
  sourceId: string,
  refreshSignal: number,
  reportRefreshed: (at?: number) => void
): TabPanelsState {
  const { source, pending } = useSourceLookup(sourceId);
  const list = usePanelList(source, sourceId);
  const min = (id: TabPanelId): number => list.panels.find(p => p.id === id)?.refreshSeconds ?? 0;
  const useOne = (id: TabPanelId): PanelState =>
    usePanel(source, id, refreshSignal, min(id), reportRefreshed, sourceId);
  // One call for each panel, in a fixed order, so the hook order never changes.
  const engines = useOne('engines');
  const clusters = useOne('clusters');
  const failback = useOne('failback');
  const services = useOne('services');
  const replication = useOne('replication');
  const storage = useOne('storage');
  const backups = useOne('backups');
  const states = [engines, clusters, failback, services, replication, storage, backups];
  useReportStale(
    states.reduce<number | undefined>(
      (a, s) =>
        s.staleSince === undefined ? a : a === undefined ? s.staleSince : Math.min(a, s.staleSince),
      undefined
    )
  );
  return {
    panels: {
      engines: engines.panel,
      clusters: clusters.panel,
      failback: failback.panel,
      services: services.panel,
      replication: replication.panel,
      storage: storage.panel,
      backups: backups.panel,
    },
    states,
    source,
    loading: states.some(s => s.loading) || pending,
    error: states.find(s => s.error)?.error ?? null,
    none: states.every(s => !s.panel),
  };
}
