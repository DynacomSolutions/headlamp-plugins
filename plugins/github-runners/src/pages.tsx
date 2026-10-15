import { CommonComponents } from '@kinvolk/headlamp-plugin/lib';
const { Link: HLink, SectionBox, StatusLabel, Table } = CommonComponents;
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import MuiLink from '@mui/material/Link';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import React from 'react';
import { useHistory, useLocation, useParams } from 'react-router-dom';
import { CapacityView } from './capacity-view';
import { Board, useBoard, useConfig } from './data';
import {
  ageSeconds,
  ago,
  buildProjectTree,
  Filters,
  matchesJob,
  matchesStarting,
  nodeBadge,
  parseTerms,
  repoUrl,
  runUrl,
  STALE_AFTER_S,
  Tab as TabId,
  tabFromParam,
  tabPath,
  TreeProject,
  viewFromSearch,
  viewToSearch,
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
  const badge = nodeBadge(node);
  return (
    <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: 1.5, minWidth: 260 }}>
      <Box display="flex" alignItems="center" gap={1} flexWrap="wrap">
        <Typography variant="h6">{node.display_name}</Typography>
        <Tooltip title={node.state_reason || ''}>
          <span>
            <StatusLabel status={badge.status}>{badge.label}</StatusLabel>
          </span>
        </Tooltip>
        {node.best_effort && <StatusLabel status="">best-effort</StatusLabel>}
        <Button size="small" onClick={onHistory}>History</Button>
      </Box>
      <Typography variant="caption" color="text.secondary" display="block">
        {node.kind === 'external' ? 'Registered outside Kubernetes' : 'Kubernetes node'} · {node.os}
        {node.description ? ` · ${node.description}` : ''}
      </Typography>
      {node.state_reason && (
        <Typography variant="caption" color="text.secondary" display="block">
          {node.state_reason}
        </Typography>
      )}
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

function Toggle({ open, onClick, label, children }: {
  open: boolean;
  onClick: () => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <Button
      size="small"
      onClick={onClick}
      aria-expanded={open}
      aria-label={`${open ? 'Collapse' : 'Expand'} ${label}`}
      sx={{ textTransform: 'none', justifyContent: 'flex-start', minWidth: 0 }}
    >
      {open ? '\u25BE' : '\u25B8'}&nbsp;{children}
    </Button>
  );
}

function ProjectTree({ projects }: { projects: TreeProject[] }) {
  // Explicit user choices; everything starts open because the tree is live.
  const [open, setOpen] = React.useState<Record<string, boolean>>({});
  const isOpen = (key: string) => open[key] ?? true;
  const flip = (key: string) => setOpen(o => ({ ...o, [key]: !(o[key] ?? true) }));
  if (!projects.length) {
    return (
      <Typography variant="body2" color="text.secondary" sx={{ p: 1 }}>
        No live jobs
      </Typography>
    );
  }
  const age = (iso_?: string | null) => {
    const secs = ageSeconds(iso_);
    return secs === null ? '-' : ago(secs);
  };
  const row = (key: string, cells: React.ReactNode[]) => (
    <Box component="li" key={key} display="flex" gap={1.5} alignItems="center" flexWrap="wrap">
      {cells.map((c, i) => (
        <React.Fragment key={i}>{c}</React.Fragment>
      ))}
    </Box>
  );
  const muted = (t: string) => (
    <Typography variant="caption" color="text.secondary">
      {t}
    </Typography>
  );
  const group = (key: string, label: string, summary: string, body: React.ReactNode, title: React.ReactNode) => (
    <li key={key}>
      <Box display="flex" alignItems="center" gap={2} flexWrap="wrap">
        <Toggle open={isOpen(key)} onClick={() => flip(key)} label={label}>
          {title}
        </Toggle>
        {muted(summary)}
      </Box>
      {isOpen(key) && (
        <Box component="ul" sx={{ listStyle: 'none', m: 0, pl: 3 }}>
          {body}
        </Box>
      )}
    </li>
  );
  const n = (c: number, w: string) => `${c} ${w}${c === 1 ? '' : 's'}`;
  return (
    <Box component="ul" sx={{ listStyle: 'none', m: 0, p: 1 }}>
      {projects.map(p => {
        const pk = `p:${p.name}`;
        return group(
          pk,
          `project ${p.name}`,
          `${p.running} running · ${p.pending} pending · ${n(p.runs.length, 'workflow run')}`,
          <>
            {p.runs.map(r => {
              const rk = `r:${p.name}|${r.key}`;
              return group(
                rk,
                `workflow run ${r.label}`,
                `${n(r.jobs.length, 'job')} · oldest started ${age(r.oldest)}`,
                r.jobs.map(({ job, node }) => {
                  const [st, label] = jobStatus(job);
                  return row(job.key, [
                    <Ext href={job.url}>{job.name || 'Job'}</Ext>,
                    muted(`${job.runner_name} · ${node} · ${job.scale_set}`),
                    <StatusLabel status={st}>{label}</StatusLabel>,
                    muted(age(job.started_at)),
                  ]);
                }),
                <Ext href={r.url}>{r.label}</Ext>
              );
            })}
            {p.waiting.length > 0 &&
              group(
                `w:${p.name}`,
                `waiting for runner in ${p.name}`,
                n(p.waiting.length, 'runner'),
                p.waiting.map(w =>
                  row(`${w.node}|${w.runner_name}`, [
                    <span>{w.runner_name}</span>,
                    muted(`${w.node} · ${w.scale_set}`),
                    <StatusLabel status="warning">{w.phase || 'Pending'}</StatusLabel>,
                    muted(age(w.started_at)),
                  ])
                ),
                'Waiting for runner'
              )}
          </>,
          <b>{p.name}</b>
        );
      })}
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
  const cfg = useConfig();
  const projects = React.useMemo(() => buildProjectTree(status, cfg, filters), [status, cfg, filters]);
  return (
    <>
      <SectionBox title="Projects">
        <ProjectTree projects={projects} />
      </SectionBox>
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
  const history = useHistory();
  const location = useLocation();
  const params = useParams<{ tab?: string }>();
  const tab = tabFromParam(params.tab);
  const view = React.useMemo(() => viewFromSearch(location.search), [location.search]);
  const q = view.q;
  const nodeSel = view.nodes;
  const setSel = view.sets;
  // Filters replace the history entry; tabs push so back and forward work.
  const setView = (patch: Partial<typeof view>) =>
    history.replace({ pathname: location.pathname, search: viewToSearch({ ...view, ...patch }) });
  const setTab = (t: TabId, search = location.search) =>
    history.push({ pathname: tabPath(location.pathname, t), search });
  const [, setTick] = React.useState(0);
  React.useEffect(() => {
    const t = setInterval(() => setTick(x => x + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const hasConfig = board.remote.configured;

  const filters: Filters = React.useMemo(
    () => ({ nodes: nodeSel, scaleSets: setSel, terms: parseTerms(q) }),
    [nodeSel, setSel, q]
  );
  const toggle = (list: string[], key: 'nodes' | 'sets', v: string) =>
    setView({ [key]: list.includes(v) ? list.filter(x => x !== v) : [...list, v] });

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
          value={`${status.summary.nodes_ready} / ${status.summary.nodes_total}${
            status.summary.nodes_standby ? ` (${status.summary.nodes_standby} standby)` : ''
          }`}
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
          onChange={e => setView({ q: e.target.value })}
          sx={{ minWidth: 240 }}
        />
        {status.nodes.map(n => (
          <Chip
            key={n.id}
            size="small"
            label={n.display_name}
            color={nodeSel.includes(n.id) ? 'primary' : 'default'}
            onClick={() => toggle(nodeSel, 'nodes', n.id)}
          />
        ))}
        {status.scale_sets.map(s => (
          <Chip
            key={s.name}
            size="small"
            variant="outlined"
            label={s.name}
            color={setSel.includes(s.name) ? 'primary' : 'default'}
            onClick={() => toggle(setSel, 'sets', s.name)}
          />
        ))}
        {(q || nodeSel.length > 0 || setSel.length > 0) && (
          <Button
            size="small"
            onClick={() => setView({ q: '', nodes: [], sets: [] })}
          >
            Clear filters
          </Button>
        )}
      </Box>
      <Tabs value={tab} onChange={(_, v) => setTab(v as TabId)} sx={{ mb: 1 }}>
        <Tab value="overview" label="Overview" />
        <Tab value="capacity" label="Capacity" />
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
            setTab('history', viewToSearch({ ...view, nodes: [id] }));
          }}
        />
      )}
      {tab === 'capacity' && <CapacityView board={board} />}
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
