import type { PluginSettingsDetailsProps } from '@kinvolk/headlamp-plugin/lib';
import { ConfigStore } from '@kinvolk/headlamp-plugin/lib';
import Box from '@mui/material/Box';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import React from 'react';
import { DEFAULT_NODES_SETTINGS, NodesSettings, resolveNodesSettings } from './nodes/agents';

export const CONFIG_KEY = 'usage';

export const configStore = new ConfigStore<Record<string, unknown>>(CONFIG_KEY);

let defaultsPromise: Promise<Record<string, unknown>> | null = null;

/**
 * Deployment defaults: an optional defaults.json next to main.js in the plugin directory. It lets an
 * installer preset the settings (for example the runner pool prefix) for every browser.
 */
function loadDefaults(): Promise<Record<string, unknown>> {
  if (!defaultsPromise) {
    defaultsPromise = fetch(`/plugins/${CONFIG_KEY}/defaults.json`)
      .then(r => (r.ok ? r.json() : {}))
      .then(j => (j && typeof j === 'object' && !Array.isArray(j) ? (j as Record<string, unknown>) : {}))
      .catch(() => ({}));
  }
  return defaultsPromise;
}

/** Browser-local overrides layered over the deployment defaults, then the built-in defaults. */
export function useNodesSettings(): NodesSettings {
  const stored = configStore.useConfig()() as Record<string, unknown> | undefined;
  const [defaults, setDefaults] = React.useState<Record<string, unknown>>({});
  React.useEffect(() => {
    let alive = true;
    loadDefaults().then(d => alive && setDefaults(d));
    return () => {
      alive = false;
    };
  }, []);
  return React.useMemo(() => {
    const merged: Record<string, unknown> = { ...defaults };
    // A stored value wins when it is not blank.
    for (const [k, v] of Object.entries(stored || {})) {
      if (v !== '' && v !== null && v !== undefined) merged[k] = v;
    }
    return resolveNodesSettings(merged);
  }, [defaults, stored]);
}

export function Settings(props: PluginSettingsDetailsProps) {
  const { data, onDataChange } = props;
  const set = (key: string, value: string) =>
    onDataChange?.({ ...((data || {}) as Record<string, unknown>), [key]: value });
  const backends = (data as any)?.agentBackends;
  return (
    <Box display="flex" flexDirection="column" gap={2} maxWidth={720}>
      <Typography variant="body2">
        Settings for the Usage dashboard. Blank fields use the built-in default.
      </Typography>
      <TextField
        label="Agent backends"
        helperText="Comma-separated agent-resource backends, each as service/<namespace>/<name>:<port>. They are reached through the Kubernetes API service proxy. The old place, the Service agent-resource in the namespace agent-memory, is the fallback when the new one does not answer."
        value={Array.isArray(backends) ? backends.join(', ') : backends ?? ''}
        placeholder={DEFAULT_NODES_SETTINGS.agentBackends.join(', ')}
        onChange={e => set('agentBackends', e.target.value)}
        fullWidth
      />
      <TextField
        label="Idle threshold (seconds)"
        helperText="Full screen (kiosk) only: with no touch for this time, the dashboard goes back to the overview. At least 30."
        value={(data as any)?.idleSeconds ?? ''}
        placeholder={String(DEFAULT_NODES_SETTINGS.idleSeconds)}
        onChange={e => set('idleSeconds', e.target.value)}
        fullWidth
      />
      <TextField
        label="Display names"
        helperText="One id=Name per line, for example my-runners=My runners. The id is a namespace, pod, container or arc key. It overrides every guessed name."
        multiline
        minRows={3}
        value={
          typeof (data as any)?.displayNames === 'string'
            ? (data as any).displayNames
            : Object.entries((data as any)?.displayNames ?? {})
                .map(([k, v]) => `${k}=${v}`)
                .join('\n')
        }
        onChange={e => set('displayNames', e.target.value)}
        fullWidth
      />
      <TextField
        label="Runner pool prefix"
        helperText="Optional. The word that starts the metric and label names of your runner pool service, for example a prefix of acme reads acme_runner_job_info and the pod labels acme.io/tenant, acme.io/pool and acme.io/role. Blank: the runner rings are off and no query goes out for them."
        value={(data as any)?.runnerPoolPrefix ?? ''}
        onChange={e => set('runnerPoolPrefix', e.target.value)}
        fullWidth
      />
    </Box>
  );
}
