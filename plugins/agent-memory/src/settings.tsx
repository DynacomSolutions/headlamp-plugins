import type { PluginSettingsDetailsProps } from '@kinvolk/headlamp-plugin/lib';
import Box from '@mui/material/Box';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import React from 'react';
import { DEFAULT_SETTINGS, Settings as SettingsShape } from './model';

export function Settings(props: PluginSettingsDetailsProps) {
  const { data, onDataChange } = props;
  const set = (key: keyof SettingsShape, value: string) =>
    onDataChange?.({ ...((data || {}) as Partial<SettingsShape>), [key]: value });
  return (
    <Box display="flex" flexDirection="column" gap={2} maxWidth={720}>
      <Typography variant="body2">
        Everything cluster-specific is configured here. Blank fields use the deployment default,
        then the built-in default.
      </Typography>
      <TextField
        label="Backend"
        helperText="The agent-memory backend as service/<namespace>/<name>:<port>. It is reached through the Kubernetes API service proxy, which is also what authorises limit changes."
        value={(data as any)?.backend ?? ''}
        placeholder={DEFAULT_SETTINGS.backend}
        onChange={e => set('backend', e.target.value)}
        fullWidth
      />
      <TextField
        label="Refresh interval (seconds)"
        helperText="Between 2 and 300."
        value={(data as any)?.refreshSeconds ?? ''}
        placeholder={String(DEFAULT_SETTINGS.refreshSeconds)}
        onChange={e => set('refreshSeconds', e.target.value)}
        fullWidth
      />
    </Box>
  );
}
