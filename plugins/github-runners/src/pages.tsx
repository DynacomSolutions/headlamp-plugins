import { Link as HLink, SectionBox, StatusLabel, Table } from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import MuiLink from '@mui/material/Link';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import React from 'react';
import { Board, useBoard } from './data';
import {
  ageSeconds,
  ago,
  Filters,
  matchesJob,
  matchesStarting,
  parseTerms,
  repoUrl,
  runUrl,
  STALE_AFTER_S,
  workflowUrl,
} from './model';
import type { Job, NodeStatus, Raw } from './types';

type HLStatus = 'success' | 'warning' | 'error' | '';

function Ext({ href, children }: { href?: string | null; children: React.ReactNode }) {
  if (!href) return <>{children}</>;
  return (
    <MuiLink href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </MuiLink>
  );
}

function jobStatus(job: Job): [HLStatus, string] {
  if (job.status === 'in_progress') return ['warning', 'in progress'];
  if (job.conclusion === 'failure') return ['error', 'failure'];
  if (job.status === 'completed' || job.conclusion === 'success') {
    return ['success', job.conclusion || 'completed'];
  }
  return ['', job.status || 'job'];
}

function phaseStatus(phase?: string): HLStatus {
  if (phase === 'Running' || phase === 'Succeeded') return 'success';
  if (phase === 'Failed') return 'error';
  if (phase === 'Pending' || phase === 'Deleting') return 'warning';
  return '';
}

function Absent({ kind }: { kind: string }) {
  return (
    <Alert severity="info" sx={{ mb: 1 }}>
      {kind} is not available: the Actions Runner Controller CRDs (actions.github.com/v1alpha1)
      are not installed in this cluster, or are not visible to you.
    </Alert>
  );
}

function Empty({ text }: { text: string }) {
  return <Typography sx={{ p: 2 }}>{text}</Typography>;
}

function PodLink({ pod, namespace }: { pod?: string; namespace?: string }) {
  if (!pod || !namespace) return <>-</>;
  return <HLink routeName="pod" params={{ namespace, name: pod }}>{pod}</HLink>;
}

function age(o: Raw): string {
  const s = ageSeconds(o?.metadata?.creationTimestamp);
  return s === null ? '-' : ago(s).replace(' ago', '');
}

/* ---------------------------------------------------------------- Overview */

function Stat({ label, value, warn }: { label: string; value: React.ReactNode; warn?: boolean }) {
  return (
    <Box sx={{ minWidth: 120 }}>
      <Typography variant="caption" color="text.secondary">
        {label}
      </Typography>
      <Typography variant="h5" color={warn ? 'error' : undefined}>
        {value}
      </Typography>
    </Box>
  );
}

function Marks({ lit, total }: { lit: number; total: number }) {
  return (
    <Box role="img" aria-label={`${lit} of ${total} busy`} sx={{ display: 'inline-flex', gap: 0.5 }}>
      {Array.from({ length: total }, (_, i) => (
        <Box
          key={i}
          sx={{
            width: 10,
            height: 10,
            borderRadius: '2px',
            bgcolor: i < lit ? 'warning.main' : 'action.disabledBackground',
          }}
        />
      ))}
    </Box>
  );
}

function NodeCard({ node, jobs, starting, onHistory }: {
  node: NodeStatus;
  jobs: number;
  starting: number;
  onHistory: () => void;
}) {
  return (
    <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: 1.5, minWidth: 260 }}>
      <Box display="flex" alignItems="center" gap={1} flexWrap="wrap">
        <Typography variant="h6">{node.display_name}</Typography>
        <StatusLabel status={node.ready ? 'success' : 'error'}>
          {node.ready ? 'ready' : 'offline'}
        </StatusLabel>
        {node.best_effort && <StatusLabel status="">best-effort</StatusLabel>}
        <Button size="small" onClick={onHistory}>History</Button>
      </Box>
      <Typography variant="caption" color="text.secondary" display="block">
        {node.kind === 'external' ? 'Registered outside Kubernetes' : 'Kubernetes node'} · {node.os}
        {node.description ? ` · ${node.description}` : ''}
      </Typography>
      <Box display="flex" alignItems="center" gap={1} mt={1}>
        <Marks lit={jobs} total={Math.max(jobs + starting, 5)} />
        <Typography variant="body2">
          {jobs ? `${jobs} job${jobs === 1 ? '' : 's'} running` : 'Idle'}
          {starting ? ` · ${starting} starting` : ''}
        </Typography>
      </Box>
    </Box>
  );
}

function jobColumns(nodes: Record<string, NodeStatus>) {
  return [
    {
      header: 'Job',
      accessorFn: (j: Job) => j.name,
      Cell: ({ row }: any) => <Ext href={row.original.url}>{row.original.name || 'Job'}</Ext>,
    },
    {
      header: 'Repository',
      accessorFn: (j: Job) => j.repository,
      Cell: ({ row }: any) => (
        <Ext href={repoUrl(row.original.repository)}>{row.original.repository || '-'}</Ext>
      ),
    },
    {
      header: 'Workflow',
      accessorFn: (j: Job) => j.workflow,
      Cell: ({ row }: any) => (
        <Ext href={workflowUrl(row.original.workflow_ref)}>{row.original.workflow || '-'}</Ext>
      ),
    },
    {
      header: 'Run',
      accessorFn: (j: Job) => String(j.run_id ?? ''),
      Cell: ({ row }: any) => (
        <Ext href={row.original.run_url || runUrl(row.original.repository, row.original.run_id)}>
          {row.original.run_id ?? '-'}
        </Ext>
      ),
    },
    {
      header: 'Node',
      accessorFn: (j: Job) => nodes[j.node_id || '']?.display_name || j.node_id || '',
    },
    { header: 'Runner', accessorFn: (j: Job) => j.runner_name },
    { header: 'Scale set', accessorFn: (j: Job) => j.scale_set },
    {
      header: 'Status',
      accessorFn: (j: Job) => jobStatus(j)[1],
      Cell: ({ row }: any) => {
        const [s, t] = jobStatus(row.original);
        return <StatusLabel status={s}>{t}</StatusLabel>;
      },
    },
  ];
}

function Overview({ board, filters, onNode }: {
  board: Board;
  filters: Filters;
  onNode: (id: string) => void;
}) {
  const { status } = board;
  const nodesById = Object.fromEntries(status.nodes.map(n => [n.id, n]));
  const shown: { node: NodeStatus; jobs: Job[]; starting: NodeStatus['starting'] }[] = [];
  for (const node of status.nodes) {
    if (filters.nodes.length && !filters.nodes.includes(node.id)) continue;
    const jobs = node.jobs.filter(j => matchesJob(j, node, filters));
    const starting = node.starting.filter(s => matchesStarting(s, node, filters));
    const filtering = filters.scaleSets.length || filters.terms.length;
    if (!jobs.length && !starting.length && filtering && node.kind !== 'external') continue;
    shown.push({ node, jobs, starting });
  }
  const allJobs = shown.flatMap(s => s.jobs);
  const allStarting = shown.flatMap(s => s.starting.map(x => ({ ...x, node: s.node })));
  return (
    <>
      <SectionBox title="Nodes">
        {shown.length === 0 ? (
          <Empty text="No nodes match the current filters." />
        ) : (
          <Box display="flex" gap={2} flexWrap="wrap" p={1}>
            {shown.map(s => (
              <NodeCard
                key={s.node.id}
                node={s.node}
                jobs={s.jobs.length}
                starting={s.starting.length}
                onHistory={() => onNode(s.node.id)}
              />
            ))}
          </Box>
        )}
      </SectionBox>
      <SectionBox title={`Live jobs (${allJobs.length})`}>
        {allJobs.length === 0 ? (
          <Empty text="No jobs are running." />
        ) : (
          <Table data={allJobs} columns={jobColumns(nodesById) as any} />
        )}
      </SectionBox>
      {allStarting.length > 0 && (
        <SectionBox title={`Starting runners (${allStarting.length})`}>
          <Table
            data={allStarting}
            columns={[
              { header: 'Runner', accessorFn: (s: any) => s.name },
              { header: 'Node', accessorFn: (s: any) => s.node.display_name },
              { header: 'Scale set', accessorFn: (s: any) => s.scale_set },
              {
                header: 'Phase',
                accessorFn: (s: any) => s.phase || 'Pending',
                Cell: ({ row }: any) => (
                  <StatusLabel status={phaseStatus(row.original.phase) || 'warning'}>
                    {row.original.phase || 'Pending'}
                  </StatusLabel>
                ),
              },
            ]}
          />
        </SectionBox>
      )}
    </>
  );
}

/* ---------------------------------------------------------------- CRD tabs */

function ScaleSets({ board }: { board: Board }) {
  const { sets, esets } = board.lists;
  return (
    <>
      <SectionBox title="AutoscalingRunnerSets">
        {sets.absent ? (
          <Absent kind="AutoscalingRunnerSet" />
        ) : sets.items.length === 0 ? (
          <Empty text="No AutoscalingRunnerSets found." />
        ) : (
          <Table
            data={sets.items}
            columns={[
              { header: 'Name', accessorFn: (o: Raw) => o.metadata.name },
              { header: 'Namespace', accessorFn: (o: Raw) => o.metadata.namespace },
              {
                header: 'Scale set',
                accessorFn: (o: Raw) => o.spec?.runnerScaleSetName || '',
              },
              {
                header: 'GitHub',
                accessorFn: (o: Raw) => o.spec?.githubConfigUrl || '',
                Cell: ({ row }: any) => {
                  const u = row.original.spec?.githubConfigUrl;
                  return u ? <Ext href={u}>{u.replace(/^https?:\/\//, '')}</Ext> : <>-</>;
                },
              },
              { header: 'Min', accessorFn: (o: Raw) => o.spec?.minRunners ?? '-' },
              { header: 'Max', accessorFn: (o: Raw) => o.spec?.maxRunners ?? '-' },
              { header: 'Current', accessorFn: (o: Raw) => o.status?.currentRunners ?? 0 },
              { header: 'Pending', accessorFn: (o: Raw) => o.status?.pendingEphemeralRunners ?? 0 },
              { header: 'Running', accessorFn: (o: Raw) => o.status?.runningEphemeralRunners ?? 0 },
              { header: 'Failed', accessorFn: (o: Raw) => o.status?.failedEphemeralRunners ?? 0 },
              {
                header: 'Phase',
                accessorFn: (o: Raw) => o.status?.phase || '',
                Cell: ({ row }: any) => (
                  <StatusLabel status={phaseStatus(row.original.status?.phase)}>
                    {row.original.status?.phase || '-'}
                  </StatusLabel>
                ),
              },
              { header: 'Age', accessorFn: age },
            ]}
          />
        )}
      </SectionBox>
      <SectionBox title="EphemeralRunnerSets">
        {esets.absent ? (
          <Absent kind="EphemeralRunnerSet" />
        ) : esets.items.length === 0 ? (
          <Empty text="No EphemeralRunnerSets found." />
        ) : (
          <Table
            data={esets.items}
            columns={[
              { header: 'Name', accessorFn: (o: Raw) => o.metadata.name },
              { header: 'Namespace', accessorFn: (o: Raw) => o.metadata.namespace },
              {
                header: 'Owner',
                accessorFn: (o: Raw) =>
                  (o.metadata.ownerReferences || []).find((r: Raw) => r.kind === 'AutoscalingRunnerSet')
                    ?.name || '-',
              },
              { header: 'Desired', accessorFn: (o: Raw) => o.spec?.replicas ?? '-' },
              { header: 'Current', accessorFn: (o: Raw) => o.status?.currentReplicas ?? 0 },
              { header: 'Pending', accessorFn: (o: Raw) => o.status?.pendingEphemeralRunners ?? 0 },
              { header: 'Running', accessorFn: (o: Raw) => o.status?.runningEphemeralRunners ?? 0 },
              { header: 'Failed', accessorFn: (o: Raw) => o.status?.failedEphemeralRunners ?? 0 },
              { header: 'Age', accessorFn: age },
            ]}
          />
        )}
      </SectionBox>
    </>
  );
}

function Runners({ board, filters }: { board: Board; filters: Filters }) {
  const { runners } = board.lists;
  const podNames = new Set(board.pods.map(p => `${p.metadata.namespace}/${p.metadata.name}`));
  const nodeOf = new Map(board.pods.map(p => [`${p.metadata.namespace}/${p.metadata.name}`, p.spec?.nodeName]));
  const rows = runners.items.filter(r => {
    const ss = r.metadata?.annotations?.['actions.github.com/runner-scale-set-name'] || '';
    if (filters.scaleSets.length && !filters.scaleSets.includes(ss)) return false;
    const hay = [r.metadata.name, ss, r.status?.jobRepositoryName, r.status?.jobDisplayName, r.status?.jobWorkflowRef, r.status?.phase]
      .join(' ')
      .toLowerCase();
    return filters.terms.every(t => hay.includes(t));
  });
  if (runners.absent) return <Absent kind="EphemeralRunner" />;
  return (
    <SectionBox title={`EphemeralRunners (${rows.length})`}>
      {rows.length === 0 ? (
        <Empty text="No EphemeralRunners match." />
      ) : (
        <Table
          data={rows}
          columns={[
            {
              header: 'Runner / pod',
              accessorFn: (o: Raw) => o.metadata.name,
              Cell: ({ row }: any) => {
                const o = row.original;
                const has = podNames.has(`${o.metadata.namespace}/${o.metadata.name}`);
                return has ? (
                  <PodLink pod={o.metadata.name} namespace={o.metadata.namespace} />
                ) : (
                  <>{o.metadata.name}</>
                );
              },
            },
            { header: 'Namespace', accessorFn: (o: Raw) => o.metadata.namespace },
            {
              header: 'Scale set',
              accessorFn: (o: Raw) =>
                o.metadata.annotations?.['actions.github.com/runner-scale-set-name'] || '',
            },
            {
              header: 'Phase',
              accessorFn: (o: Raw) => o.status?.phase || '',
              Cell: ({ row }: any) => (
                <StatusLabel status={phaseStatus(row.original.status?.phase)}>
                  {row.original.status?.phase || '-'}
                </StatusLabel>
              ),
            },
            {
              header: 'Reason',
              accessorFn: (o: Raw) => o.status?.reason || o.status?.message || '',
            },
            {
              header: 'Node',
              accessorFn: (o: Raw) => nodeOf.get(`${o.metadata.namespace}/${o.metadata.name}`) || '',
            },
            {
              header: 'Repository',
              accessorFn: (o: Raw) => o.status?.jobRepositoryName || '',
              Cell: ({ row }: any) => (
                <Ext href={repoUrl(row.original.status?.jobRepositoryName)}>
                  {row.original.status?.jobRepositoryName || '-'}
                </Ext>
              ),
            },
            {
              header: 'Workflow',
              accessorFn: (o: Raw) => o.status?.jobWorkflowRef || '',
              Cell: ({ row }: any) => {
                const ref = row.original.status?.jobWorkflowRef;
                return (
                  <Ext href={workflowUrl(ref)}>
                    {ref ? String(ref).split('@')[0].split('/').pop() : '-'}
                  </Ext>
                );
              },
            },
            {
              header: 'Job',
              accessorFn: (o: Raw) => o.status?.jobDisplayName || '',
              Cell: ({ row }: any) => {
                const s = row.original.status || {};
                return (
                  <Ext href={runUrl(s.jobRepositoryName, s.workflowRunId)}>
                    {s.jobDisplayName || (s.workflowRunId ? `run ${s.workflowRunId}` : '-')}
                  </Ext>
                );
              },
            },
            { header: 'Age', accessorFn: age },
          ]}
        />
      )}
    </SectionBox>
  );
}

function Listeners({ board }: { board: Board }) {
  const { listeners } = board.lists;
  if (listeners.absent) return <Absent kind="AutoscalingListener" />;
  const podNames = new Set(board.pods.map(p => `${p.metadata.namespace}/${p.metadata.name}`));
  return (
    <SectionBox title="AutoscalingListeners">
      {listeners.items.length === 0 ? (
        <Empty text="No AutoscalingListeners found." />
      ) : (
        <Table
          data={listeners.items}
          columns={[
            {
              header: 'Listener / pod',
              accessorFn: (o: Raw) => o.metadata.name,
              Cell: ({ row }: any) => {
                const o = row.original;
                return podNames.has(`${o.metadata.namespace}/${o.metadata.name}`) ? (
                  <PodLink pod={o.metadata.name} namespace={o.metadata.namespace} />
                ) : (
                  <>{o.metadata.name}</>
                );
              },
            },
            { header: 'Namespace', accessorFn: (o: Raw) => o.metadata.namespace },
            {
              header: 'Runner set',
              accessorFn: (o: Raw) => o.spec?.autoscalingRunnerSetName || '',
            },
            {
              header: 'Ephemeral set',
              accessorFn: (o: Raw) => o.spec?.ephemeralRunnerSetName || '',
            },
            { header: 'Min', accessorFn: (o: Raw) => o.spec?.minRunners ?? '-' },
            { header: 'Max', accessorFn: (o: Raw) => o.spec?.maxRunners ?? '-' },
            {
              header: 'GitHub',
              accessorFn: (o: Raw) => o.spec?.githubConfigUrl || '',
              Cell: ({ row }: any) => {
                const u = row.original.spec?.githubConfigUrl;
                return u ? <Ext href={u}>{u.replace(/^https?:\/\//, '')}</Ext> : <>-</>;
              },
            },
            {
              header: 'Status',
              accessorFn: (o: Raw) => o.status?.phase || o.status?.message || '',
            },
            { header: 'Age', accessorFn: age },
          ]}
        />
      )}
    </SectionBox>
  );
}

function HistoryView({ board, filters }: { board: Board; filters: Filters }) {
  const { remote, status } = board;
  if (!remote.configured) {
    return (
      <Alert severity="info">
        Job history needs the optional status endpoint. Set it in this plugin&apos;s settings
        (Settings, Plugins, GitHub Runners). Everything else works without it.
      </Alert>
    );
  }
  const nodesById = Object.fromEntries(status.nodes.map(n => [n.id, n]));
  const jobs = (remote.history?.jobs || []).filter(j =>
    (!filters.nodes.length || filters.nodes.includes(j.node_id || '')) &&
    matchesJob(j, nodesById[j.node_id || ''], filters)
  );
  return (
    <SectionBox title={`Historic jobs (${jobs.length})`}>
      {jobs.length === 0 ? (
        <Empty text={remote.history ? 'No historic jobs match.' : 'History is not available yet.'} />
      ) : (
        <Table data={jobs} columns={jobColumns(nodesById) as any} />
      )}
    </SectionBox>
  );
}

/* -------------------------------------------------------------------- Page */

export function GitHubRunnersPage() {
  const board = useBoard();
  const [tab, setTab] = React.useState('overview');
  const [q, setQ] = React.useState('');
  const [nodeSel, setNodeSel] = React.useState<string[]>([]);
  const [setSel, setSetSel] = React.useState<string[]>([]);
  const [, setTick] = React.useState(0);
  React.useEffect(() => {
    const t = setInterval(() => setTick(x => x + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const hasConfig = board.remote.configured;

  const filters: Filters = { nodes: nodeSel, scaleSets: setSel, terms: parseTerms(q) };
  const toggle = (list: string[], set: (v: string[]) => void, v: string) =>
    set(list.includes(v) ? list.filter(x => x !== v) : [...list, v]);

  const { status, remote } = board;
  const generated = remote.status ? remote.status.generated_at : status.generated_at;
  const remoteAge = remote.status ? ageSeconds(remote.status.generated_at) : null;
  const stale = remoteAge !== null && remoteAge > STALE_AFTER_S;

  return (
    <Box p={2}>
      <Typography variant="h4" gutterBottom>
        GitHub Runners
      </Typography>
      {board.errors.map(e => (
        <Alert key={e} severity="error" sx={{ mb: 1 }}>
          {e}
        </Alert>
      ))}
      {!board.arcPresent && !board.loading && (
        <Alert severity="info" sx={{ mb: 1 }}>
          The Actions Runner Controller CRDs (actions.github.com/v1alpha1) are not installed or not
          visible. Install ARC to see runner scale sets, runners and listeners here.
        </Alert>
      )}
      {hasConfig && remote.error && (
        <Alert severity="warning" sx={{ mb: 1 }}>
          Status endpoint unavailable ({remote.error}). Showing Kubernetes data only.
        </Alert>
      )}
      {stale && (
        <Alert severity="warning" sx={{ mb: 1 }}>
          Status endpoint data is stale ({ago(remoteAge as number)}).
        </Alert>
      )}
      <Box display="flex" gap={4} flexWrap="wrap" mb={2}>
        <Stat label="Running jobs" value={status.summary.running_jobs} />
        <Stat label="Pending runners" value={status.summary.pending_runners} />
        <Stat
          label="Nodes ready"
          value={`${status.summary.nodes_ready} / ${status.summary.nodes_total}`}
        />
        <Stat
          label={remote.status ? 'Enrichment data' : 'Data'}
          value={remote.status ? ago(remoteAge ?? 0) : 'live'}
          warn={stale}
        />
        {board.loading && <CircularProgress size={20} />}
      </Box>
      <Box display="flex" gap={1} flexWrap="wrap" alignItems="center" mb={1}>
        <TextField
          size="small"
          label="Search"
          value={q}
          onChange={e => setQ(e.target.value)}
          sx={{ minWidth: 240 }}
        />
        {status.nodes.map(n => (
          <Chip
            key={n.id}
            size="small"
            label={n.display_name}
            color={nodeSel.includes(n.id) ? 'primary' : 'default'}
            onClick={() => toggle(nodeSel, setNodeSel, n.id)}
          />
        ))}
        {status.scale_sets.map(s => (
          <Chip
            key={s.name}
            size="small"
            variant="outlined"
            label={s.name}
            color={setSel.includes(s.name) ? 'primary' : 'default'}
            onClick={() => toggle(setSel, setSetSel, s.name)}
          />
        ))}
        {(q || nodeSel.length > 0 || setSel.length > 0) && (
          <Button
            size="small"
            onClick={() => {
              setQ('');
              setNodeSel([]);
              setSetSel([]);
            }}
          >
            Clear filters
          </Button>
        )}
      </Box>
      <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ mb: 1 }}>
        <Tab value="overview" label="Overview" />
        <Tab value="scalesets" label="Scale sets" />
        <Tab value="runners" label="Runners" />
        <Tab value="listeners" label="Listeners" />
        <Tab value="history" label="History" />
      </Tabs>
      {tab === 'overview' && (
        <Overview
          board={board}
          filters={filters}
          onNode={id => {
            setNodeSel([id]);
            setTab('history');
          }}
        />
      )}
      {tab === 'scalesets' && <ScaleSets board={board} />}
      {tab === 'runners' && <Runners board={board} filters={filters} />}
      {tab === 'listeners' && <Listeners board={board} />}
      {tab === 'history' && <HistoryView board={board} filters={filters} />}
      <Typography variant="caption" color="text.secondary" display="block" mt={2}>
        Updated {generated}. Links open github.com; this plugin makes no GitHub API calls.
      </Typography>
    </Box>
  );
}
