import type { PluginSettingsDetailsProps } from '@kinvolk/headlamp-plugin/lib';
import Box from '@mui/material/Box';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import React from 'react';
import { PluginConfig, useConfig } from './data';

export function Settings(props: PluginSettingsDetailsProps) {
  const { data, onDataChange } = props;
  const cfg = useConfig();
  const set = (key: keyof PluginConfig) => (e: React.ChangeEvent<HTMLInputElement>) =>
    onDataChange?.({ ...((data || {}) as PluginConfig), [key]: e.target.value });
  return (
    <Box display="flex" flexDirection="column" gap={2} maxWidth={640}>
      <Typography variant="body2">
        Mappings whose hosts differ only by one of these suffixes are folded into one site. Each
        field takes a comma-separated list. Empty uses the deployment default.
      </Typography>
      <TextField
        label="Tailnet suffixes"
        helperText="Names served over https, preferred as a site's primary URL."
        value={cfg.tailnetSuffixes || ''}
        onChange={set('tailnetSuffixes')}
        placeholder=".example.com"
        fullWidth
      />
      <TextField
        label="LAN suffixes"
        helperText="Names served over plain http on the local network."
        value={cfg.lanSuffixes || ''}
        onChange={set('lanSuffixes')}
        placeholder=".example.net"
        fullWidth
      />
      <TextField
        label="Local suffixes"
        helperText="Names served over plain http on the machine itself."
        value={cfg.localSuffixes || ''}
        onChange={set('localSuffixes')}
        placeholder=".localhost"
        fullWidth
      />
    </Box>
  );
}
