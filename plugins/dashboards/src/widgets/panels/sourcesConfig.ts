/* Reads the panel sources from the Dashboards plugin settings (the same key as the settings page). */
import { ConfigStore } from '@kinvolk/headlamp-plugin/lib';
import React from 'react';
import { PanelSource, resolveSources, SOURCES_KEY } from './sources';

let store: ConfigStore<Record<string, unknown>> | undefined;
/** Created on first use, so importing a widget does not need the Headlamp store. */
export const getSettingsStore = (): ConfigStore<Record<string, unknown>> =>
  (store ??= new ConfigStore<Record<string, unknown>>('dashboards'));

const INPUT_KEYS = ['agentNamespace', 'agentService', 'agentPort', SOURCES_KEY];

/** The configured sources, the agent first. The list keeps its identity until a source setting changes. */
export function useSources(): PanelSource[] {
  const stored = getSettingsStore().useConfig()() as Record<string, unknown> | undefined;
  const fingerprint = JSON.stringify(INPUT_KEYS.map(k => stored?.[k] ?? null));
  return React.useMemo(
    () => resolveSources(stored),
    // The fingerprint covers the only inputs, so an unrelated settings change does not refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fingerprint]
  );
}

/** The sources right now, outside React. A missing store gives only the agent. */
export function readSourcesNow(): PanelSource[] {
  try {
    return resolveSources(getSettingsStore().get() as Record<string, unknown> | undefined);
  } catch {
    return resolveSources(undefined);
  }
}
