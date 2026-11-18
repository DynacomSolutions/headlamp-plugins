import type { PluginSettingsDetailsProps } from '@kinvolk/headlamp-plugin/lib';
import Box from '@mui/material/Box';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { DEFAULT_SETTINGS, Settings as SettingsShape } from './model';

const FIELDS: { key: keyof SettingsShape; label: string; help: string }[] = [
  { key: 'namespace', label: 'Agent namespace', help: 'Namespace of the headlamp-agent Service.' },
  { key: 'serviceName', label: 'Agent service', help: 'Name of the headlamp-agent Service.' },
  { key: 'servicePort', label: 'Agent port', help: 'Service port number or name.' },
];

export function Settings(props: PluginSettingsDetailsProps) {
  const { data, onDataChange } = props;
  const set = (key: keyof SettingsShape, value: string) =>
    onDataChange?.({ ...((data || {}) as Partial<SettingsShape>), [key]: value });
  return (
    <Box display="flex" flexDirection="column" gap={2} maxWidth={720}>
      <Typography variant="body2">
        The agent is reached through the Kubernetes API service proxy. Blank fields use the
        deployment default, then the built-in default.
      </Typography>
      {FIELDS.map(f => (
        <TextField
          key={f.key}
          label={f.label}
          helperText={f.help}
          value={(data as any)?.[f.key] ?? ''}
          placeholder={DEFAULT_SETTINGS[f.key]}
          onChange={e => set(f.key, e.target.value)}
          fullWidth
        />
      ))}
    </Box>
  );
}
