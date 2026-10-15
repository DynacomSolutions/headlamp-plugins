import type { PluginSettingsDetailsProps } from '@kinvolk/headlamp-plugin/lib';
import Box from '@mui/material/Box';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import React from 'react';
import { DEFAULT_SETTINGS, Settings as SettingsShape } from './model';

const FIELDS: { key: keyof SettingsShape; label: string; help: string }[] = [
  { key: 'namespace', label: 'Backend namespace', help: 'Namespace of the registry catalogue Service.' },
  { key: 'service', label: 'Backend service', help: 'Name of the registry catalogue Service.' },
  { key: 'port', label: 'Backend port', help: 'Service port number or name.' },
  {
    key: 'namePrefixes',
    label: 'VM image name prefixes',
    help: 'Comma-separated repository prefixes treated as VM images. Repositories with VM artefact media types are included too.',
  },
  { key: 'refreshSeconds', label: 'Refresh interval (seconds)', help: 'Between 5 and 600.' },
];

export function Settings(props: PluginSettingsDetailsProps) {
  const { data, onDataChange } = props;
  const set = (key: keyof SettingsShape, value: string) =>
    onDataChange?.({ ...((data || {}) as Partial<SettingsShape>), [key]: value });
  return (
    <Box display="flex" flexDirection="column" gap={2} maxWidth={720}>
      <Typography variant="body2">
        The backend is reached through the Kubernetes API service proxy. Blank fields use the
        deployment default, then the built-in default.
      </Typography>
      {FIELDS.map(f => (
        <TextField
          key={f.key}
          label={f.label}
          helperText={f.help}
          value={(data as any)?.[f.key] ?? ''}
          placeholder={String(DEFAULT_SETTINGS[f.key])}
          onChange={e => set(f.key, e.target.value)}
          fullWidth
        />
      ))}
    </Box>
  );
}
