/* The Workflows page: one table grouped by app, one row per workflow or CronJob. */
import { SectionBox } from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import React from 'react';
import { instancesTitle, StatusChip, SummaryBar, TimeCell, WorkloadStatusChip } from './cells';
import { Loaded, loadRaw, useSettings } from './data';
import {
  buildAll,
  errorLabel,
  formatDuration,
  formatExact,
  formatExit,
  formatInterval,
  formatNextDue,
  groupRows,
  healthSummary,
  Row,
  Settings,
  summarise,
  WorkloadRow,
} from './model';

export const REFRESH_MS = 30_000;

/** Loads the series now and every 30 seconds. A failed refresh keeps the last good data. */
export function useWorkflows(settings: Settings): Loaded {
  const [state, setState] = React.useState<Loaded>({ loading: true });
  React.useEffect(() => {
    let alive = true;
    const tick = () =>
      loadRaw(settings)
        .then(({ raw, kubeError }) => alive && setState({ raw, kubeError, loading: false, at: Date.now() }))
        .catch(e => alive && setState(s => ({ ...s, error: String(e?.message || e), loading: false })));
    tick();
    const id = window.setInterval(tick, REFRESH_MS);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [settings]);
  return state;
}

const COLUMNS = [
  'Status',
  'Workflow',
  'Kind',
  'Last run',
  'Last success',
  'Failures in a row',
  'Expected interval',
  'Next due',
  'Last error class',
  'Component or pod',
];

function WorkflowRow({ row, now }: { row: Row; now: number }): JSX.Element {
  const pods = instancesTitle(row);
  const nextText = formatNextDue(row, now);
  const late = row.nextDue > 0 && row.nextDue < now && row.status !== 'suspended';
  return (
    <TableRow hover>
      <TableCell>
        <StatusChip row={row} />
      </TableCell>
      <TableCell>
        <Typography variant="body2" sx={{ fontWeight: 500 }}>
          {row.name}
        </Typography>
      </TableCell>
      <TableCell>{row.kind}</TableCell>
      <TableCell>
        <TimeCell ts={row.lastRun} now={now} />
      </TableCell>
      <TableCell>
        <TimeCell ts={row.lastSuccess} now={now} />
      </TableCell>
      <TableCell align="right" sx={{ color: row.failures >= 3 ? 'error.main' : row.failures > 0 ? 'warning.main' : undefined }}>
        {row.failures}
      </TableCell>
      <TableCell sx={{ whiteSpace: 'nowrap' }}>{formatInterval(row)}</TableCell>
      <TableCell sx={{ whiteSpace: 'nowrap', color: late ? 'error.main' : undefined }}>
        {row.nextDue > 0 ? (
          <Tooltip title={formatExact(row.nextDue)}>
            <span>{nextText}</span>
          </Tooltip>
        ) : (
          nextText
        )}
      </TableCell>
      <TableCell>{errorLabel(row.errorClass)}</TableCell>
      <TableCell>
        {pods ? (
          <Tooltip title={<span style={{ whiteSpace: 'pre-line' }}>{pods}</span>}>
            <span>
              {row.where} +{row.instances.length - 1}
            </span>
          </Tooltip>
        ) : (
          row.where
        )}
      </TableCell>
    </TableRow>
  );
}

const WORKLOAD_COLUMNS = ['Status', 'Workload', 'Kind', 'Ready', 'Not ready for', 'Restarts (24 h)', 'Last exit'];

function WorkloadTableRow({ row }: { row: WorkloadRow }): JSX.Element {
  const exit = formatExit(row.lastExit);
  return (
    <TableRow hover>
      <TableCell>
        <WorkloadStatusChip row={row} />
      </TableCell>
      <TableCell>
        <Tooltip title={row.pods.length > 0 ? row.pods.join('\n') : 'No pods'}>
          <Typography variant="body2" sx={{ fontWeight: 500 }} component="span">
            {row.name}
          </Typography>
        </Tooltip>
      </TableCell>
      <TableCell>{row.kind}</TableCell>
      <TableCell>
        {row.ready}/{row.desired}
      </TableCell>
      <TableCell sx={{ whiteSpace: 'nowrap' }}>{row.notReadySeconds > 0 ? formatDuration(row.notReadySeconds) : '-'}</TableCell>
      <TableCell align="right" sx={{ color: row.restarts24h > 0 ? 'warning.main' : undefined }}>
        {row.restarts24h}
      </TableCell>
      <TableCell>
        {row.lastExit ? (
          <Tooltip title={`${row.lastExit.pod} / ${row.lastExit.container}`}>
            <span>{exit}</span>
          </Tooltip>
        ) : (
          exit
        )}
      </TableCell>
    </TableRow>
  );
}

/** Workloads grouped by namespace, failing first (the list is already sorted). */
function WorkloadsTable({ workloads }: { workloads: WorkloadRow[] }): JSX.Element {
  const namespaces: string[] = [];
  for (const w of workloads) if (!namespaces.includes(w.namespace)) namespaces.push(w.namespace);
  return (
    <Box sx={{ overflowX: 'auto' }}>
      <Table size="small" aria-label="Workloads">
        <TableHead>
          <TableRow>
            {WORKLOAD_COLUMNS.map(c => (
              <TableCell key={c} align={c === 'Restarts (24 h)' ? 'right' : undefined}>
                {c}
              </TableCell>
            ))}
          </TableRow>
        </TableHead>
        <TableBody>
          {namespaces.map(ns => (
            <React.Fragment key={ns}>
              <TableRow>
                <TableCell colSpan={WORKLOAD_COLUMNS.length} sx={{ bgcolor: 'action.hover', borderBottom: 'none' }}>
                  <Typography variant="subtitle2" component="span">
                    {ns}
                  </Typography>
                </TableCell>
              </TableRow>
              {workloads
                .filter(w => w.namespace === ns)
                .map(w => (
                  <WorkloadTableRow key={w.id} row={w} />
                ))}
            </React.Fragment>
          ))}
        </TableBody>
      </Table>
    </Box>
  );
}

export function WorkflowsPage(): JSX.Element {
  const settings = useSettings();
  const { raw, error, kubeError, loading, at } = useWorkflows(settings);
  const now = Math.floor((at ?? Date.now()) / 1000);
  const built = React.useMemo(() => (raw ? buildAll(raw, settings.cronJobNamespaces, now) : undefined), [raw, settings.cronJobNamespaces, now]);
  const rows = built?.rows;
  const workloads = built?.workloads ?? [];
  const groups = React.useMemo(() => (rows ? groupRows(rows, 'auto') : []), [rows]);
  const counts = rows ? summarise(rows) : undefined;
  const health = rows ? healthSummary(rows, workloads) : undefined;
  return (
    <SectionBox title="Workflows">
      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          Could not read workflow series: {error}
        </Alert>
      )}
      {kubeError && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          CronJobs and workloads are missing: could not read the kube-state-metrics series ({kubeError}).
        </Alert>
      )}
      {loading && !rows && <CircularProgress />}
      {rows && rows.length === 0 && workloads.length === 0 && (
        <Alert severity="info">
          No workflows yet. No series named "&lt;prefix&gt;_workflow_last_success_timestamp_seconds" exist, and no CronJob is in scope.
        </Alert>
      )}
      {rows && counts && health && (rows.length > 0 || workloads.length > 0) && (
        <>
          <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'center', mb: 2 }}>
            <SummaryBar summary={health} />
            <Typography variant="caption" color="text.secondary" sx={{ ml: 'auto' }}>
              refreshed {at ? new Date(at).toLocaleTimeString() : '-'} · every {REFRESH_MS / 1000} s
            </Typography>
          </Box>
          {rows.length > 0 && (
            <>
              <Typography variant="h6" component="h2" sx={{ mb: 1 }}>
                Workflows and CronJobs
              </Typography>
              <Box sx={{ overflowX: 'auto' }}>
                <Table size="small" aria-label="Workflows">
                  <TableHead>
                    <TableRow>
                      {COLUMNS.map(c => (
                        <TableCell key={c} align={c === 'Failures in a row' ? 'right' : undefined}>
                          {c}
                        </TableCell>
                      ))}
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {groups.map(g => (
                      <React.Fragment key={g.key}>
                        <TableRow>
                          <TableCell colSpan={COLUMNS.length} sx={{ bgcolor: 'action.hover', borderBottom: 'none' }}>
                            <Typography variant="subtitle2" component="span">
                              {g.key}
                            </Typography>
                            <Typography variant="caption" color="text.secondary" component="span" sx={{ ml: 1 }}>
                              {g.rows.length} {g.rows.length === 1 ? 'workflow' : 'workflows'}
                              {g.prefixes.length > 0 ? ` · ${g.prefixes.join(', ')}` : ''}
                            </Typography>
                          </TableCell>
                        </TableRow>
                        {g.rows.map(r => (
                          <WorkflowRow key={r.id} row={r} now={now} />
                        ))}
                      </React.Fragment>
                    ))}
                  </TableBody>
                </Table>
              </Box>
              <Typography variant="body2" color="text.secondary" sx={{ mt: 1, mb: 3 }}>
                {rows.length} {rows.length === 1 ? 'workflow' : 'workflows'}
              </Typography>
            </>
          )}
          {workloads.length > 0 && (
            <>
              <Typography variant="h6" component="h2" sx={{ mb: 1 }}>
                Workloads
              </Typography>
              <WorkloadsTable workloads={workloads} />
              <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                {workloads.length} {workloads.length === 1 ? 'workload' : 'workloads'}
              </Typography>
            </>
          )}
        </>
      )}
    </SectionBox>
  );
}
