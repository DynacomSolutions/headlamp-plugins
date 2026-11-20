/*
 * The panel sources on the Dashboards settings page. The first source is the built-in agent
 * (the three agent fields of earlier versions, kept under the same keys). Other sources are a
 * list under `panelSources`. Each source has a Test button that asks it for its panel list.
 */
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import MenuItem from '@mui/material/MenuItem';
import Paper from '@mui/material/Paper';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import React from 'react';
import { reason, testSource } from './data';
import { useSettingsCluster } from './settingsCluster';
import {
  agentSource,
  blankDraft,
  DEFAULT_AGENT,
  draftProblem,
  draftToSource,
  PanelSource,
  readDrafts,
  SourceDraft,
  SOURCES_KEY,
} from './sources';
import { useSources } from './sourcesConfig';
import { useSyncSourceWidgets } from './variants';

type Settings = Record<string, unknown>;

type TestResult =
  | { state: 'idle' }
  | { state: 'running' }
  | { state: 'ok'; count: number }
  | { state: 'error'; message: string };

/** The Test button and its result. `source` is null while the fields are not valid. */
export function SourceTest({
  source,
  problem,
}: {
  source: PanelSource | null;
  problem: string | null;
}): JSX.Element {
  const [result, setResult] = React.useState<TestResult>({ state: 'idle' });
  const cluster = useSettingsCluster();
  const run = () => {
    if (!source) return;
    setResult({ state: 'running' });
    testSource(source, cluster).then(
      count => setResult({ state: 'ok', count }),
      e => setResult({ state: 'error', message: reason(e) })
    );
  };
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}>
      <Button
        size="small"
        variant="outlined"
        disabled={!source || result.state === 'running'}
        onClick={run}
      >
        Test
      </Button>
      <Box role="status" aria-live="polite" sx={{ minWidth: 0 }}>
        {result.state === 'running' && <Typography variant="body2">Asking the source.</Typography>}
        {result.state === 'ok' && (
          <Typography variant="body2" data-test-result="ok">
            Works: {result.count} {result.count === 1 ? 'panel' : 'panels'}.
          </Typography>
        )}
        {result.state === 'error' && (
          <Alert severity="error" data-test-result="error" sx={{ py: 0 }}>
            {result.message}
          </Alert>
        )}
        {result.state === 'idle' && problem && (
          <Typography variant="caption" color="text.secondary">
            {problem}
          </Typography>
        )}
      </Box>
    </Box>
  );
}

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

function SourceEditor(props: {
  draft: SourceDraft;
  taken: string[];
  onChange: (d: SourceDraft) => void;
  onRemove: () => void;
}): JSX.Element {
  const { draft, taken, onChange, onRemove } = props;
  const problem = draftProblem(draft, taken);
  const set = (patch: Partial<SourceDraft>) => onChange({ ...draft, ...patch });
  const source = problem === null ? draftToSource(draft) : null;
  return (
    <Paper
      variant="outlined"
      sx={{ p: 2, display: 'flex', flexDirection: 'column', gap: 2 }}
      data-source-editor
    >
      <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
        <TextField
          size="small"
          label="Id"
          value={draft.id}
          onChange={e => set({ id: e.target.value })}
          helperText="Saved in widgets. For example my-app."
          sx={{ flex: '1 1 160px' }}
        />
        <TextField
          size="small"
          label="Title"
          value={draft.title}
          onChange={e => set({ title: e.target.value })}
          helperText="Shown in the palette."
          sx={{ flex: '1 1 200px' }}
        />
        <TextField
          size="small"
          label="Icon"
          value={draft.icon}
          placeholder="mdi:server"
          onChange={e => set({ icon: e.target.value })}
          helperText="Optional mdi: name."
          sx={{ flex: '1 1 160px' }}
        />
        <TextField
          select
          size="small"
          label="Kind"
          value={draft.kind}
          onChange={e => set({ kind: e.target.value as SourceDraft['kind'] })}
          sx={{ flex: '1 1 160px' }}
        >
          <MenuItem value="service">Kubernetes service</MenuItem>
          <MenuItem value="url">URL</MenuItem>
        </TextField>
      </Box>
      {draft.kind === 'service' ? (
        <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
          <TextField
            size="small"
            label="Namespace"
            value={draft.namespace}
            onChange={e => set({ namespace: e.target.value })}
            placeholder="my-namespace"
            sx={{ flex: '1 1 160px' }}
          />
          <TextField
            size="small"
            label="Service"
            value={draft.service}
            onChange={e => set({ service: e.target.value })}
            placeholder="my-app"
            sx={{ flex: '1 1 160px' }}
          />
          <TextField
            size="small"
            label="Port"
            value={draft.port}
            onChange={e => set({ port: e.target.value })}
            placeholder="80"
            sx={{ flex: '1 1 100px' }}
          />
          <TextField
            size="small"
            label="Path prefix"
            value={draft.pathPrefix}
            onChange={e => set({ pathPrefix: e.target.value })}
            placeholder="/my-app"
            helperText="Optional. Goes before /api/widgets."
            sx={{ flex: '1 1 160px' }}
          />
        </Box>
      ) : (
        <TextField
          size="small"
          label="Base URL"
          value={draft.baseUrl}
          onChange={e => set({ baseUrl: e.target.value })}
          placeholder="https://my-app.example.com"
          helperText="The browser calls it directly, with its cookies. The app must allow this origin (CORS with credentials). No token is stored."
          fullWidth
        />
      )}
      {problem && draft.id.trim() !== '' && (
        <Alert severity="warning" sx={{ py: 0 }}>
          {problem}
        </Alert>
      )}
      <Box
        sx={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          gap: 2,
          flexWrap: 'wrap',
        }}
      >
        <SourceTest source={source} problem={problem} />
        <Button size="small" color="error" onClick={onRemove}>
          Remove source
        </Button>
      </Box>
    </Paper>
  );
}

export function SourcesSettingsSection(props: {
  data: Settings | undefined;
  onChange: (data: Settings) => void;
}): JSX.Element {
  const { data, onChange } = props;
  const drafts = readDrafts(data);
  // The saved sources, for the palette: one entry per source.
  useSyncSourceWidgets(useSources());
  const write = (next: SourceDraft[]) => onChange({ ...(data ?? {}), [SOURCES_KEY]: next });
  return (
    <Box display="flex" flexDirection="column" gap={2}>
      <Typography variant="h6" component="h2">
        Panel sources
      </Typography>
      <Typography variant="body2">
        The panel widgets read panels from a source: the built-in agent, a Kubernetes service
        (through the API service proxy, so Kubernetes permissions apply) or a URL that the browser
        calls with its own cookies. Every source serves GET /api/widgets and GET
        /api/widgets/&lt;id&gt;. Use Test to check a source.
      </Typography>
      <AgentSource data={data} onChange={onChange} />
      {drafts.map((d, i) => (
        <SourceEditor
          key={i}
          draft={d}
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
