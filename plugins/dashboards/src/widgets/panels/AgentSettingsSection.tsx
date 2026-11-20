/* The agent location fields on the Dashboards settings page, for the agent panel widget. */
import Box from '@mui/material/Box';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import React from 'react';
import { DEFAULT_AGENT } from './model';

const FIELDS = [
  { key: 'agentNamespace', label: 'Agent namespace', help: 'Namespace of the headlamp-agent Service.', fallback: DEFAULT_AGENT.namespace },
  { key: 'agentService', label: 'Agent service', help: 'Name of the headlamp-agent Service.', fallback: DEFAULT_AGENT.serviceName },
  { key: 'agentPort', label: 'Agent port', help: 'Service port number or name.', fallback: DEFAULT_AGENT.servicePort },
] as const;

export function AgentSettingsSection(props: {
  data: Record<string, unknown> | undefined;
  onChange: (data: Record<string, unknown>) => void;
}): JSX.Element {
  const { data, onChange } = props;
  return (
    <Box display="flex" flexDirection="column" gap={2}>
      <Typography variant="body2">
        The agent panel widget reads its panels from the headlamp-agent Service, through the Kubernetes API service proxy. A blank
        field uses the default.
      </Typography>
      {FIELDS.map(f => (
        <TextField
          key={f.key}
          label={f.label}
          helperText={f.help}
          value={typeof data?.[f.key] === 'string' ? (data[f.key] as string) : ''}
          placeholder={f.fallback}
          onChange={e => onChange({ ...(data ?? {}), [f.key]: e.target.value })}
          fullWidth
        />
      ))}
    </Box>
  );
}
