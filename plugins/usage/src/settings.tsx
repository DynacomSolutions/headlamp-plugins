import type { PluginSettingsDetailsProps } from '@kinvolk/headlamp-plugin/lib';
import { ConfigStore } from '@kinvolk/headlamp-plugin/lib';
import Box from '@mui/material/Box';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import React from 'react';
import { DEFAULT_NODES_SETTINGS, NodesSettings, resolveNodesSettings } from './nodes/agents';

export const CONFIG_KEY = 'usage';

export const configStore = new ConfigStore<Record<string, unknown>>(CONFIG_KEY);

/** Browser-local overrides layered over the built-in defaults. */
export function useNodesSettings(): NodesSettings {
  const stored = configStore.useConfig()() as Record<string, unknown> | undefined;
  return React.useMemo(() => resolveNodesSettings(stored), [stored]);
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
        helperText="Comma-separated agent-memory backends, each as service/<namespace>/<name>:<port>. They are reached through the Kubernetes API service proxy."
        value={Array.isArray(backends) ? backends.join(', ') : backends ?? ''}
        placeholder={DEFAULT_NODES_SETTINGS.agentBackends.join(', ')}
        onChange={e => set('agentBackends', e.target.value)}
        fullWidth
      />
      <TextField
        label="Idle threshold (seconds)"
        helperText="At least 30."
        value={(data as any)?.idleSeconds ?? ''}
        placeholder={String(DEFAULT_NODES_SETTINGS.idleSeconds)}
        onChange={e => set('idleSeconds', e.target.value)}
        fullWidth
      />
      <TextField
        label="Display names"
        helperText="One id=Name per line, for example runwarden-runners=Runwarden. The id is a namespace, pod, container or arc key. It overrides every guessed name."
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
    </Box>
  );
}
