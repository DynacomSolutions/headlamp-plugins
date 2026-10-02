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
  const text = (key: keyof SettingsShape, label: string, helper: string, placeholder?: string) => (
    <TextField
      label={label}
      helperText={helper}
      value={(data as any)?.[key] ?? ''}
      placeholder={placeholder}
      onChange={e => set(key, e.target.value)}
      fullWidth
    />
  );
  return (
    <Box display="flex" flexDirection="column" gap={2} maxWidth={720}>
      <Typography variant="body2">
        Everything cluster-specific is configured here. Blank fields use the default.
      </Typography>
      {text(
        'group',
        'CRD group',
        'API group of NotificationChannel and AlertRoute.',
        DEFAULT_SETTINGS.group
      )}
      {text(
        'version',
        'CRD version',
        'API version of the custom resources.',
        DEFAULT_SETTINGS.version
      )}
      {text(
        'namespace',
        'Namespace',
        'Namespace holding the channels, routes and referenced Secrets.',
        DEFAULT_SETTINGS.namespace
      )}
      {text(
        'stateApiUrl',
        'State API URL',
        'Empty hides the Status page. Use an https URL, or service/<namespace>/<name>:<port>/<path> to go through the cluster API proxy.',
        'service/monitoring/alert-state:8080/state'
      )}
    </Box>
  );
}
