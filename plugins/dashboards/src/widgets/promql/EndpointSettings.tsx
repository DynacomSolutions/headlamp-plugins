/* The metrics endpoint fields on the Dashboards settings page, for the PromQL widgets. */
import Box from '@mui/material/Box';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import React from 'react';
import { DEFAULT_ENDPOINT, isEndpointName, isEndpointPort, isPathPrefix } from './endpoint';

const FIELDS = [
  {
    key: 'metricsNamespace',
    label: 'Metrics namespace',
    help: 'Namespace of the Prometheus-compatible Service.',
    fallback: DEFAULT_ENDPOINT.namespace,
    valid: isEndpointName,
  },
  {
    key: 'metricsService',
    label: 'Metrics service',
    help: 'Name of the Service (VictoriaMetrics, Prometheus or similar).',
    fallback: DEFAULT_ENDPOINT.service,
    valid: isEndpointName,
  },
  {
    key: 'metricsPort',
    label: 'Metrics port',
    help: 'Service port number or name.',
    fallback: DEFAULT_ENDPOINT.port,
    valid: isEndpointPort,
  },
  {
    key: 'metricsPathPrefix',
    label: 'Metrics path prefix',
    help: 'A path in front of /api/v1, for example /prometheus. Blank for none.',
    fallback: '/prometheus',
    valid: isPathPrefix,
  },
] as const;

export function MetricsEndpointSection(props: {
  data: Record<string, unknown> | undefined;
  onChange: (data: Record<string, unknown>) => void;
}): JSX.Element {
  const { data, onChange } = props;
  return (
    <Box display="flex" flexDirection="column" gap={2}>
      <Typography variant="body2">
        The PromQL widgets query this Service through the Kubernetes API service proxy. A blank
        field uses the default. The signed in user needs the get verb on services/proxy there.
      </Typography>
      {FIELDS.map(f => {
        const value = typeof data?.[f.key] === 'string' ? (data[f.key] as string) : '';
        const invalid = value.trim() !== '' && !f.valid(value.trim().replace(/\/+$/, ''));
        return (
          <TextField
            key={f.key}
            label={f.label}
            error={invalid}
            helperText={invalid ? 'This value is not valid, so the default is used.' : f.help}
            value={value}
            placeholder={f.key === 'metricsPathPrefix' ? '' : f.fallback}
            onChange={e => onChange({ ...(data ?? {}), [f.key]: e.target.value })}
            fullWidth
          />
        );
      })}
    </Box>
  );
}
