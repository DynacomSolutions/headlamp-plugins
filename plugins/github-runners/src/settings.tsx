import type { PluginSettingsDetailsProps } from '@kinvolk/headlamp-plugin/lib/plugin/pluginsSlice';
import Box from '@mui/material/Box';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import React from 'react';
import { useConfig } from './data';
import type { PluginConfig } from './types';

export function Settings(props: PluginSettingsDetailsProps) {
  const { data, onDataChange } = props;
  const cfg = useConfig();
  const set = (key: keyof PluginConfig) => (e: React.ChangeEvent<HTMLInputElement>) =>
    onDataChange?.({ ...((data || {}) as PluginConfig), [key]: e.target.value });
  return (
    <Box display="flex" flexDirection="column" gap={2} maxWidth={640}>
      <Typography variant="body2">
        Everything works from Kubernetes objects alone. The optional fields below add GitHub-side
        detail and history from a JSON status endpoint (the scanner&apos;s status.json /
        history.json). The browser never holds a GitHub token; the endpoint does the API calls.
      </Typography>
      <TextField
        label="Status endpoint"
        helperText="A cluster path such as /api/v1/namespaces/NS/services/NAME:PORT/proxy/data/status.json (fetched through the Kubernetes API), or an absolute https URL. Empty disables."
        value={cfg.statusUrl || ''}
        onChange={set('statusUrl')}
        placeholder="https://status.example.com/data/status.json"
        fullWidth
      />
      <TextField
        label="History endpoint"
        helperText="Defaults to the status endpoint with status.json replaced by history.json."
        value={cfg.historyUrl || ''}
        onChange={set('historyUrl')}
        fullWidth
      />
      <TextField
        label="External worker API group"
        helperText="Optional CRD group serving 'externalworkers' (for example a laptop or Mac builder registered outside the cluster). Empty disables."
        value={cfg.externalWorkerGroup || ''}
        onChange={set('externalWorkerGroup')}
        placeholder="platform.example.com"
        fullWidth
      />
      <TextField
        label="External worker API version"
        value={cfg.externalWorkerVersion || ''}
        onChange={set('externalWorkerVersion')}
        placeholder="v1alpha1"
        fullWidth
      />
      <TextField
        label="Node display names"
        helperText="Comma-separated id=Label pairs, for example node-a=Primary,node-b=Edge."
        value={cfg.nodeAliases || ''}
        onChange={set('nodeAliases')}
        fullWidth
      />
    </Box>
  );
}
