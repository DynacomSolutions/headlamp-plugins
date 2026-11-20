/* Reads where the agent is from the Dashboards plugin settings (the same key as the settings page). */
import { ConfigStore } from '@kinvolk/headlamp-plugin/lib';
import React from 'react';
import { AgentSettings, resolveAgent } from './model';

let store: ConfigStore<Record<string, unknown>> | undefined;
/** Created on first use, so importing the widget does not need the Headlamp store. */
const getStore = (): ConfigStore<Record<string, unknown>> => (store ??= new ConfigStore<Record<string, unknown>>('dashboards'));

export function useAgentSettings(): AgentSettings {
  const stored = getStore().useConfig()() as Record<string, unknown> | undefined;
  return React.useMemo(
    () => resolveAgent(stored),
    // The three fields are the only inputs, so an unrelated settings change does not refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [stored?.agentNamespace, stored?.agentService, stored?.agentPort]
  );
}
