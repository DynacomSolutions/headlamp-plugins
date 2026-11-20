/*
 * The cluster sources on the Dashboards settings page: the sources of the ConfigMap
 * `dashboard-sources`, shared by every browser. They show as read-only rows with a Test button.
 * A user with write access can open "Edit cluster sources" and save the ConfigMap.
 */
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import React from 'react';
import { resolveNamespace } from '../../namespace';
import { canWriteConfigMaps } from '../../transport';
import { loadClusterSources, saveClusterSources } from './clusterSources';
import { useSettingsCluster } from './settingsCluster';
import { SourceEditor, SourceTest } from './SourceEditor';
import {
  blankDraft,
  CLUSTER_SOURCES_NAME,
  draftProblem,
  draftToSource,
  PanelSource,
  SourceDraft,
  toDraft,
} from './sources';
import { getSettingsStore, transportFor, useClusterSourcesState } from './sourcesConfig';

/** Where a source points, as short text. */
export function describeLocation(s: PanelSource): string {
  if (s.kind === 'url') return s.baseUrl;
  return `${s.namespace}/${s.service}:${s.port}${s.pathPrefix}`;
}

const asDraft = (s: PanelSource): SourceDraft => toDraft(s as unknown as Record<string, unknown>);

/** Whether the user may create and update ConfigMaps in the namespace. undefined while unknown. */
function useCanEditSources(cluster: string | undefined, namespace: string): boolean | undefined {
  const [allowed, setAllowed] = React.useState<boolean | undefined>(undefined);
  React.useEffect(() => {
    let live = true;
    setAllowed(undefined);
    canWriteConfigMaps(transportFor(cluster), namespace, ['create', 'update']).then(
      v => live && setAllowed(v)
    );
    return () => {
      live = false;
    };
  }, [cluster, namespace]);
  return allowed;
}

function EditDialog(props: {
  initial: SourceDraft[];
  cluster: string | undefined;
  namespace: string;
  onClose: () => void;
}): JSX.Element {
  const { initial, cluster, namespace, onClose } = props;
  const [drafts, setDrafts] = React.useState<SourceDraft[]>(initial);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const problems = drafts.map((d, i) =>
    draftProblem(
      d,
      drafts.filter((_, j) => j !== i).map(o => o.id.trim())
    )
  );
  const invalid = problems.some(p => p !== null);
  const save = async () => {
    setBusy(true);
    setError('');
    try {
      await saveClusterSources(
        transportFor(cluster),
        cluster,
        namespace,
        drafts.map(draftToSource)
      );
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="md" aria-labelledby="cluster-sources-title">
      <DialogTitle id="cluster-sources-title">Edit cluster sources</DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: 1 }}>
        <Alert severity="info" sx={{ py: 0 }}>
          This saves the ConfigMap {CLUSTER_SOURCES_NAME} in the namespace {namespace}. Every
          browser sees the change. If the ConfigMap is managed by GitOps, the next sync can revert
          your change.
        </Alert>
        {drafts.map((d, i) => (
          <SourceEditor
            key={i}
            draft={d}
            taken={drafts.filter((_, j) => j !== i).map(o => o.id.trim())}
            onChange={nd => setDrafts(drafts.map((o, j) => (j === i ? nd : o)))}
            onRemove={() => setDrafts(drafts.filter((_, j) => j !== i))}
          />
        ))}
        <Box>
          <Button
            size="small"
            variant="outlined"
            onClick={() => setDrafts([...drafts, blankDraft()])}
          >
            Add a source
          </Button>
        </Box>
        {error && <Alert severity="error">{error}</Alert>}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" disabled={busy || invalid} onClick={save}>
          Save to the cluster
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export function ClusterSourcesSection(props: { overridden: ReadonlySet<string> }): JSX.Element {
  const cluster = useSettingsCluster();
  const stored = getSettingsStore().useConfig()() as Record<string, unknown> | undefined;
  const namespace = resolveNamespace(stored);
  const state = useClusterSourcesState(cluster);
  const canEdit = useCanEditSources(cluster, namespace);
  const [editing, setEditing] = React.useState(false);
  return (
    <Box display="flex" flexDirection="column" gap={2} data-cluster-sources>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
        <Typography variant="subtitle1" component="h3" sx={{ flexGrow: 1 }}>
          Cluster sources
        </Typography>
        <Button
          size="small"
          onClick={() => void loadClusterSources(transportFor(cluster), cluster, namespace)}
          disabled={state.status === 'loading'}
        >
          Reload
        </Button>
        <Button
          size="small"
          variant="outlined"
          disabled={canEdit !== true || state.status === 'loading'}
          onClick={() => setEditing(true)}
        >
          Edit cluster sources
        </Button>
      </Box>
      <Typography variant="body2" color="text.secondary">
        Shared by every browser. They come from the ConfigMap {CLUSTER_SOURCES_NAME} (label
        headlamp.dev/dashboard-sources=true, key sources.json) in the namespace {namespace}.
      </Typography>
      {canEdit === false && (
        <Alert severity="info" sx={{ py: 0 }} data-read-only>
          You have read-only access to the cluster sources. Ask a cluster admin for create and
          update on ConfigMaps in the namespace {namespace} to change them.
        </Alert>
      )}
      {state.status === 'error' && (
        <Alert severity="error" data-cluster-error>
          Could not read the cluster sources: {state.error}
        </Alert>
      )}
      {state.problems.length > 0 && (
        <Alert severity="warning" data-cluster-problems>
          {state.problems.map(p => (
            <div key={p}>{p}</div>
          ))}
        </Alert>
      )}
      {state.status === 'ready' && state.sources.length === 0 && state.problems.length === 0 && (
        <Typography variant="body2" color="text.secondary">
          {state.exists
            ? 'The ConfigMap has no sources.'
            : `There is no ConfigMap ${CLUSTER_SOURCES_NAME} in the namespace ${namespace}, so no cluster sources.`}
        </Typography>
      )}
      {state.sources.map(s => (
        <Paper
          key={s.id}
          variant="outlined"
          sx={{ p: 2, display: 'flex', flexDirection: 'column', gap: 1.5 }}
          data-cluster-source={s.id}
        >
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
            <Typography variant="subtitle2">{s.title}</Typography>
            <Chip size="small" label="Cluster" />
            <Typography variant="caption" color="text.secondary">
              id {s.id}
            </Typography>
          </Box>
          <Typography variant="body2" color="text.secondary" sx={{ wordBreak: 'break-all' }}>
            {s.kind === 'url' ? 'URL' : 'Service'}: {describeLocation(s)}
          </Typography>
          {props.overridden.has(s.id) && (
            <Alert severity="info" sx={{ py: 0 }} data-overridden>
              A source of this browser with the id {s.id} overrides this one here.
            </Alert>
          )}
          <SourceTest source={s} problem={null} />
        </Paper>
      ))}
      {editing && (
        <EditDialog
          initial={state.sources.map(asDraft)}
          cluster={cluster}
          namespace={namespace}
          onClose={() => setEditing(false)}
        />
      )}
    </Box>
  );
}
