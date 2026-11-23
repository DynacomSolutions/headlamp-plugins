import type { PluginSettingsDetailsProps } from '@kinvolk/headlamp-plugin/lib';
import Box from '@mui/material/Box';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { DEFAULT_SETTINGS, Settings as SettingsShape } from './model';

const FIELDS: { key: keyof SettingsShape; label: string; help: string }[] = [
  { key: 'metricsNamespace', label: 'Metrics namespace', help: 'Namespace of the Prometheus-compatible Service.' },
  { key: 'metricsService', label: 'Metrics service', help: 'Name of the Service.' },
  { key: 'metricsPort', label: 'Metrics port', help: 'Service port number.' },
  {
    key: 'cronJobNamespaces',
    label: 'CronJob namespaces',
    help: 'Empty: only namespaces that have workflow series. A comma separated list adds namespaces. * shows the CronJobs of every namespace.',
  },
];

export function Settings(props: PluginSettingsDetailsProps) {
  const { data, onDataChange } = props;
  const set = (key: keyof SettingsShape, value: string) =>
    onDataChange?.({ ...((data || {}) as Partial<SettingsShape>), [key]: value });
  return (
    <Box display="flex" flexDirection="column" gap={2} maxWidth={720}>
      <Typography variant="body2">
        The metrics are read through the Kubernetes API service proxy. Blank fields use the deployment
        default, then the built-in default.
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
