import type { PluginSettingsDetailsProps } from '@kinvolk/headlamp-plugin/lib';
import Box from '@mui/material/Box';
import FormControlLabel from '@mui/material/FormControlLabel';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import React from 'react';
import { DEFAULT_SETTINGS, resolveSettings, Settings as SettingsShape } from './model';

export function Settings(props: PluginSettingsDetailsProps) {
  const { data, onDataChange } = props;
  const cur = resolveSettings(data as Partial<SettingsShape>);
  const set = (key: keyof SettingsShape, value: string | boolean) =>
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
      <FormControlLabel
        control={<Switch checked={cur.gitops} onChange={e => set('gitops', e.target.checked)} />}
        label="GitOps mode: edits generate manifests for a pull request instead of writing live resources"
      />
      {text(
        'proposalUrl',
        'Proposal endpoint',
        'URL accepting POST {path, content, message} and returning {prUrl}. Empty offers Copy and Download only. service/<namespace>/<name>:<port>/<path> is proxied.',
        'https://proposals.example.com/propose'
      )}
      {text(
        'proposalPath',
        'Repository path',
        'Directory in the Git repository the manifests are written under.',
        DEFAULT_SETTINGS.proposalPath
      )}
      <FormControlLabel
        control={
          <Switch checked={cur.directApply} onChange={e => set('directApply', e.target.checked)} />
        }
        label="Direct apply: also allow writing live resources (only for clusters not managed by GitOps)"
      />
    </Box>
  );
}
