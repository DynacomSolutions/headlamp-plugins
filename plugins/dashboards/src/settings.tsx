import type { PluginSettingsDetailsProps } from '@kinvolk/headlamp-plugin/lib';
import { ConfigStore } from '@kinvolk/headlamp-plugin/lib';
import Box from '@mui/material/Box';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import React from 'react';
import { isNamespaceName, resolveNamespace } from './namespace';
import { DEFAULT_NAMESPACE } from './storage/storage';
import { SourcesSettingsSection } from './widgets/panels/SourcesSettingsSection';
import { MetricsEndpointSection } from './widgets/promql/EndpointSettings';

export const CONFIG_KEY = 'dashboards';
export const configStore = new ConfigStore<Record<string, unknown>>(CONFIG_KEY);

export { isNamespaceName, resolveNamespace };

export function useDashboardNamespace(): string {
  const stored = configStore.useConfig()() as Record<string, unknown> | undefined;
  return resolveNamespace(stored);
}

export function Settings(props: PluginSettingsDetailsProps) {
  const { data, onDataChange } = props;
  const value = typeof (data as any)?.namespace === 'string' ? (data as any).namespace : '';
  const invalid = value.trim() !== '' && !isNamespaceName(value.trim());
  return (
    <Box display="flex" flexDirection="column" gap={2} maxWidth={720}>
      <Typography variant="body2">
        Settings for Dashboards. Each dashboard is one ConfigMap with the label
        headlamp.dev/dashboard=true.
      </Typography>
      <TextField
        label="Namespace"
        helperText={
          invalid
            ? 'This is not a valid namespace name. The default is used.'
            : `The namespace that holds the dashboards. It must exist. Blank uses ${DEFAULT_NAMESPACE}. Reading needs list and get on ConfigMaps there. Saving needs create, update and delete.`
        }
        error={invalid}
        value={value}
        placeholder={DEFAULT_NAMESPACE}
        onChange={e =>
          onDataChange?.({
            ...((data || {}) as Record<string, unknown>),
            namespace: e.target.value,
          })
        }
        fullWidth
      />
      <SourcesSettingsSection
        data={data as Record<string, unknown> | undefined}
        onChange={d => onDataChange?.(d)}
      />
      <MetricsEndpointSection
        data={data as Record<string, unknown> | undefined}
        onChange={d => onDataChange?.(d)}
      />
    </Box>
  );
}
