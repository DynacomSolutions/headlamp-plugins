/*
 * The panel sources on the Dashboards settings page. The first source is the built-in agent
 * (the three agent fields of earlier versions, kept under the same keys). Then come the cluster
 * sources (read only here, shared by every browser), then the sources of this browser: a
 * list under `panelSources`. Each source has a Test button that asks it for its panel list.
 */
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Paper from '@mui/material/Paper';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import React from 'react';
import { ClusterSourcesSection } from './ClusterSourcesSection';
import { useSettingsCluster } from './settingsCluster';
import { SourceEditor, SourceTest } from './SourceEditor';
import {
  agentSource,
  blankDraft,
  DEFAULT_AGENT,
  overriddenClusterIds,
  readDrafts,
  SourceDraft,
  SOURCES_KEY,
} from './sources';
import { useClusterSourcesState, useSources } from './sourcesConfig';
import { useSyncSourceWidgets } from './variants';

type Settings = Record<string, unknown>;

function AgentSource({
  data,
  onChange,
}: {
  data: Settings | undefined;
  onChange: (d: Settings) => void;
}): JSX.Element {
  const fields = [
    {
      key: 'agentNamespace',
      label: 'Agent namespace',
      help: 'Namespace of the agent Service.',
      fallback: DEFAULT_AGENT.namespace,
    },
    {
      key: 'agentService',
      label: 'Agent service',
      help: 'Name of the agent Service.',
      fallback: DEFAULT_AGENT.service,
    },
    {
      key: 'agentPort',
      label: 'Agent port',
      help: 'Service port number or name.',
      fallback: DEFAULT_AGENT.port,
    },
  ] as const;
  return (
    <Paper
      variant="outlined"
      sx={{ p: 2, display: 'flex', flexDirection: 'column', gap: 2 }}
      data-source="agent"
    >
      <Typography variant="subtitle2">Agent (built in)</Typography>
      <Typography variant="body2" color="text.secondary">
        The agent layer is always the first source, with the id agent. A blank field uses the
        default.
      </Typography>
      {fields.map(f => (
        <TextField
          key={f.key}
          size="small"
          label={f.label}
          helperText={f.help}
          value={typeof data?.[f.key] === 'string' ? (data[f.key] as string) : ''}
          placeholder={f.fallback}
          onChange={e => onChange({ ...(data ?? {}), [f.key]: e.target.value })}
          fullWidth
        />
      ))}
      <SourceTest source={agentSource(data)} problem={null} />
    </Paper>
  );
}

export function SourcesSettingsSection(props: {
  data: Settings | undefined;
  onChange: (data: Settings) => void;
}): JSX.Element {
  const { data, onChange } = props;
  const drafts = readDrafts(data);
  const cluster = useSettingsCluster();
  const clusterState = useClusterSourcesState(cluster);
  const overridden = overriddenClusterIds(data, clusterState.sources);
  // The saved sources, for the palette: one entry per source.
  useSyncSourceWidgets(useSources(cluster));
  const write = (next: SourceDraft[]) => onChange({ ...(data ?? {}), [SOURCES_KEY]: next });
  return (
    <Box display="flex" flexDirection="column" gap={2}>
      <Typography variant="h6" component="h2">
        Panel sources
      </Typography>
      <Typography variant="body2">
        The panel widgets read panels from a source: the built-in agent, a source that the cluster
        shares with every browser, or a source of this browser. A source is a Kubernetes service
        (through the API service proxy, so Kubernetes permissions apply) or a URL that the browser
        calls with its own cookies. Every source serves GET /api/widgets and GET
        /api/widgets/&lt;id&gt;. Use Test to check a source.
      </Typography>
      <AgentSource data={data} onChange={onChange} />
      <ClusterSourcesSection overridden={overridden} />
      <Typography variant="subtitle1" component="h3">
        Sources of this browser
      </Typography>
      <Typography variant="body2" color="text.secondary">
        These sources are saved in this browser only. A source here with the id of a cluster source
        replaces it for this browser.
      </Typography>
      {drafts.map((d, i) => (
        <SourceEditor
          key={i}
          draft={d}
          note={
            overridden.has(d.id.trim())
              ? 'This source overrides the cluster source with the same id, in this browser only.'
              : undefined
          }
          taken={drafts.filter((_, j) => j !== i).map(o => o.id.trim())}
          onChange={nd => write(drafts.map((o, j) => (j === i ? nd : o)))}
          onRemove={() => write(drafts.filter((_, j) => j !== i))}
        />
      ))}
      <Box>
        <Button variant="outlined" size="small" onClick={() => write([...drafts, blankDraft()])}>
          Add a source
        </Button>
      </Box>
    </Box>
  );
}
