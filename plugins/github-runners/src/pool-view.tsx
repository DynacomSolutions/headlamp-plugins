import { CommonComponents } from '@kinvolk/headlamp-plugin/lib';
const { SectionBox, StatusLabel, Table } = CommonComponents;
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import React from 'react';
import type { Board } from './data';
import {
  Failure,
  filterFailures,
  filterJobTimes,
  filterNodes,
  filterPools,
  filterQueue,
  JobTimes,
  Machine,
  NodeLoad,
  PanelSeries,
  PanelStatus,
  Pool,
  PoolFilter,
  QueueEntry,
} from './pool';

type HLStatus = 'success' | 'warning' | 'error' | '';

export const labelStatus = (s: PanelStatus): HLStatus =>
  s === 'ok' ? 'success' : s === 'warn' ? 'warning' : s === 'crit' ? 'error' : '';

const num = (n: number | null): string => (n === null ? '-' : String(n));

function Empty({ text }: { text: string }) {
  return <Typography sx={{ p: 2 }}>{text}</Typography>;
}

/** A horizontal fill bar for a 0 to 1 fraction. */
function Fill({ fraction, status, label }: { fraction: number | null; status: PanelStatus; label: string }) {
  if (fraction === null) return <>-</>;
  const pct = Math.min(100, Math.max(0, fraction * 100));
  const colour = status === 'crit' ? 'error.main' : status === 'warn' ? 'warning.main' : 'success.main';
  return (
    <Box
      role="img"
      aria-label={label}
      sx={{ width: 140, height: 10, borderRadius: '2px', overflow: 'hidden', bgcolor: 'action.disabledBackground' }}
    >
      <Box sx={{ width: `${pct}%`, height: '100%', bgcolor: colour }} />
    </Box>
  );
}

function StatusCell({ status, children }: { status: PanelStatus; children: React.ReactNode }) {
  return <StatusLabel status={labelStatus(status)}>{children}</StatusLabel>;
}

/* ------------------------------------------------------------------ tables */

function PoolsTable({ pools, title }: { pools: Pool[]; title: string }) {
  return (
    <SectionBox title={`${title} (${pools.length})`}>
      {pools.length === 0 ? (
        <Empty text="No pools match." />
      ) : (
        <Table
          data={pools}
          columns={[
            { header: 'Pool', accessorFn: (p: Pool) => p.name },
            { header: 'Running', accessorFn: (p: Pool) => p.running ?? -1, Cell: ({ row }: any) => num(row.original.running) },
            {
              header: 'Queued',
              accessorFn: (p: Pool) => p.queued ?? -1,
              Cell: ({ row }: any) => {
                const p: Pool = row.original;
                return p.queued ? <StatusLabel status="warning">{p.queued}</StatusLabel> : <>{num(p.queued)}</>;
              },
            },
            { header: 'Free slots', accessorFn: (p: Pool) => p.free ?? -1, Cell: ({ row }: any) => num(row.original.free) },
            { header: 'Cap', accessorFn: (p: Pool) => p.cap ?? -1, Cell: ({ row }: any) => num(row.original.cap) },
            {
              header: 'Slots used',
              accessorFn: (p: Pool) => p.fraction ?? -1,
              Cell: ({ row }: any) => {
                const p: Pool = row.original;
                return (
                  <Fill
                    fraction={p.fraction}
                    status={p.status}
                    label={`${num(p.running)} of ${num(p.cap)} slots used`}
                  />
                );
              },
            },
            {
              header: 'Runners',
              accessorFn: (p: Pool) => p.runnersDetail,
              Cell: ({ row }: any) => <>{row.original.runnersDetail || '-'}</>,
            },
          ]}
        />
      )}
    </SectionBox>
  );
}

function QueueTable({ rows }: { rows: QueueEntry[] }) {
  const total = rows.reduce((n, r) => n + (r.queued ?? 0), 0);
  return (
    <SectionBox title={`Queue (${total} queued, ${rows.length} ${rows.length === 1 ? 'group' : 'groups'})`}>
      {rows.length === 0 ? (
        <Empty text="No jobs are queued." />
      ) : (
        <Table
          data={rows}
          columns={[
            { header: 'Owner', accessorFn: (r: QueueEntry) => r.owner },
            { header: 'Pool', accessorFn: (r: QueueEntry) => r.pool || '-' },
            {
              header: 'Queued',
              accessorFn: (r: QueueEntry) => r.queued ?? -1,
              Cell: ({ row }: any) => num(row.original.queued),
            },
            {
              header: 'Oldest waiting',
              accessorFn: (r: QueueEntry) => r.oldest,
              Cell: ({ row }: any) => (
                <StatusCell status={row.original.status}>{row.original.oldest || '-'}</StatusCell>
              ),
            },
          ]}
        />
      )}
    </SectionBox>
  );
}

function NodesTable({ nodes }: { nodes: NodeLoad[] }) {
  return (
    <SectionBox title={`Nodes (${nodes.length})`}>
      {nodes.length === 0 ? (
        <Empty text="No nodes match." />
      ) : (
        <Table
          data={nodes}
          columns={[
            { header: 'Node', accessorFn: (n: NodeLoad) => n.name },
            {
              header: 'CPU (used / total cores)',
              accessorFn: (n: NodeLoad) => n.cpuUsed ?? -1,
              Cell: ({ row }: any) => {
                const n: NodeLoad = row.original;
                return n.cpuTotal === null ? <>-</> : <>{`${n.cpuUsed} / ${n.cpuTotal}`}</>;
              },
            },
            {
              header: 'Memory (used / total GiB)',
              accessorFn: (n: NodeLoad) => n.memUsed ?? -1,
              Cell: ({ row }: any) => {
                const n: NodeLoad = row.original;
                return n.memTotal === null ? <>-</> : <>{`${n.memUsed} / ${n.memTotal}`}</>;
              },
            },
            {
              header: 'Runners now',
              accessorFn: (n: NodeLoad) => n.runners ?? -1,
              Cell: ({ row }: any) => num(row.original.runners),
            },
            {
              header: 'Load',
              accessorFn: (n: NodeLoad) => n.fraction ?? -1,
              Cell: ({ row }: any) => {
                const n: NodeLoad = row.original;
                return (
                  <Box display="flex" alignItems="center" gap={1}>
                    <Fill fraction={n.fraction} status={n.status} label={`Load ${n.value}`} />
                    <StatusCell status={n.status}>{n.value}</StatusCell>
                  </Box>
                );
              },
            },
          ]}
        />
      )}
    </SectionBox>
  );
}

function MachinesTable({ machines }: { machines: Machine[] }) {
  return (
    <SectionBox title={`Persistent machines (${machines.length})`}>
      {machines.length === 0 ? (
        <Empty text="No persistent machines." />
      ) : (
        <Table
          data={machines}
          columns={[
            { header: 'Machine', accessorFn: (m: Machine) => m.name },
            { header: 'State', accessorFn: (m: Machine) => m.detail },
            {
              header: 'Value',
              accessorFn: (m: Machine) => m.value,
              Cell: ({ row }: any) => <StatusCell status={row.original.status}>{row.original.value}</StatusCell>,
            },
          ]}
        />
      )}
    </SectionBox>
  );
}

function JobTimesTable({ rows }: { rows: JobTimes[] }) {
  return (
    <SectionBox title={`Job times by pool (${rows.length})`}>
      {rows.length === 0 ? (
        <Empty text="No jobs in the recent window." />
      ) : (
        <Table
          data={rows}
          columns={[
            { header: 'Pool', accessorFn: (r: JobTimes) => r.pool },
            { header: 'Jobs', accessorFn: (r: JobTimes) => r.jobs ?? -1, Cell: ({ row }: any) => num(row.original.jobs) },
            { header: 'Wait p50', accessorFn: (r: JobTimes) => r.waitP50 ?? '-' },
            { header: 'Wait p90', accessorFn: (r: JobTimes) => r.waitP90 ?? '-' },
            { header: 'Start p50', accessorFn: (r: JobTimes) => r.startP50 ?? '-' },
            {
              header: 'Run p50',
              accessorFn: (r: JobTimes) => r.run ?? '-',
              Cell: ({ row }: any) => <StatusCell status={row.original.status}>{row.original.run ?? '-'}</StatusCell>,
            },
          ]}
        />
      )}
    </SectionBox>
  );
}

function FailuresTable({ rows }: { rows: Failure[] }) {
  return (
    <SectionBox title={`Failures by repository (${rows.length})`}>
      {rows.length === 0 ? (
        <Empty text="No jobs in the recent window." />
      ) : (
        <Table
          data={rows}
          columns={[
            { header: 'Repository', accessorFn: (r: Failure) => r.repository },
            { header: 'Jobs', accessorFn: (r: Failure) => r.jobs ?? -1, Cell: ({ row }: any) => num(row.original.jobs) },
            { header: 'Failed', accessorFn: (r: Failure) => r.failed ?? -1, Cell: ({ row }: any) => num(row.original.failed) },
            {
              header: 'Cancelled',
              accessorFn: (r: Failure) => r.cancelled ?? -1,
              Cell: ({ row }: any) => num(row.original.cancelled),
            },
            {
              header: 'Failure rate',
              accessorFn: (r: Failure) => r.fraction ?? -1,
              Cell: ({ row }: any) => {
                const r: Failure = row.original;
                return (
                  <Box display="flex" alignItems="center" gap={1}>
                    <Fill fraction={r.fraction} status={r.status} label={`Failure rate ${r.rate}`} />
                    <StatusCell status={r.status}>{r.rate}</StatusCell>
                  </Box>
                );
              },
            },
          ]}
        />
      )}
    </SectionBox>
  );
}

/** A line of points, drawn as SVG in the current text colour. Used for the job time series. */
export function Spark({ series, colour }: { series: PanelSeries; colour: string }) {
  const w = 360;
  const h = 64;
  const pts = series.points;
  if (pts.length < 2) return <Typography variant="body2">No data.</Typography>;
  const max = Math.max(...pts, 0);
  const min = Math.min(...pts, 0);
  const span = max - min || 1;
  const x = (i: number) => (i / (pts.length - 1)) * (w - 4) + 2;
  const y = (v: number) => h - 4 - ((v - min) / span) * (h - 8);
  const d = pts.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
  return (
    <Box sx={{ color: colour }}>
      <svg
        role="img"
        aria-label={`${series.label}: ${pts.length} jobs, from ${min} to ${max}`}
        width={w}
        height={h}
        viewBox={`0 0 ${w} ${h}`}
      >
        <path d={d} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" />
      </svg>
    </Box>
  );
}

function SeriesBox({ series }: { series: PanelSeries[] }) {
  const colours = ['primary.main', 'warning.main', 'success.main', 'info.main'];
  return (
    <SectionBox title="Recent jobs">
      {series.length === 0 ? (
        <Empty text="No job series yet." />
      ) : (
        <Box display="flex" gap={4} flexWrap="wrap" p={1}>
          {series.map((s, i) => (
            <Box key={s.label}>
              <Typography variant="subtitle2">
                {s.label} · {s.points.length} jobs, oldest first
              </Typography>
              <Spark series={s} colour={colours[i % colours.length]} />
            </Box>
          ))}
        </Box>
      )}
    </SectionBox>
  );
}

/* ------------------------------------------------------------------- tabs */

export interface PoolTabProps {
  board: Board;
  filter: PoolFilter;
}

/** Overview: slots per pool, then the queue. */
export function PoolOverview({ board, filter }: PoolTabProps) {
  const rw = board.pool.board;
  if (!rw) return null;
  return (
    <>
      <PoolsTable pools={filterPools(rw.pools, filter)} title="Pools" />
      <QueueTable rows={filterQueue(rw.queue, filter)} />
    </>
  );
}

/** Capacity: slots, node load and persistent machines. */
export function PoolCapacity({ board, filter }: PoolTabProps) {
  const rw = board.pool.board;
  if (!rw) return null;
  return (
    <>
      <PoolsTable pools={filterPools(rw.pools, filter)} title="Pool capacity" />
      <NodesTable nodes={filterNodes(rw.nodes, filter)} />
      <MachinesTable machines={rw.machines} />
    </>
  );
}

/** Runners: pods by state in each pool. */
export function PoolRunners({ board, filter }: PoolTabProps) {
  const rw = board.pool.board;
  if (!rw) return null;
  const pools = filterPools(rw.pools, filter).filter(p => p.runnersDetail);
  const states = Array.from(new Set(pools.flatMap(p => p.runners.map(([k]) => k))));
  return (
    <SectionBox title={`Runners by state (${pools.length} pools)`}>
      {pools.length === 0 ? (
        <Empty text="No runners are reported." />
      ) : (
        <Table
          data={pools}
          columns={[
            { header: 'Pool', accessorFn: (p: Pool) => p.name },
            ...states.map(state => ({
              header: state.charAt(0).toUpperCase() + state.slice(1),
              accessorFn: (p: Pool) => p.runners.find(([k]) => k === state)?.[1] ?? 0,
            })),
            {
              header: 'Total',
              accessorFn: (p: Pool) => p.runners.reduce((n, [, c]) => n + c, 0),
            },
            {
              header: 'Busy',
              accessorFn: (p: Pool) => p.fraction ?? -1,
              Cell: ({ row }: any) => {
                const p: Pool = row.original;
                const [used, total] = p.runnersDetail ? [p.runners.find(([k]) => k === 'busy')?.[1], p.runners.reduce((n, [, c]) => n + c, 0)] : [undefined, 0];
                return (
                  <Fill
                    fraction={total ? (used ?? 0) / total : null}
                    status={p.runnerStatus ?? 'unknown'}
                    label={`${used ?? 0} of ${total} runners busy`}
                  />
                );
              },
            },
          ]}
        />
      )}
    </SectionBox>
  );
}

/** History: wait, start and run times, and failures of the last jobs. */
export function PoolHistory({ board, filter }: PoolTabProps) {
  const rw = board.pool.board;
  if (!rw) return null;
  return (
    <>
      <JobTimesTable rows={filterJobTimes(rw.jobTimes, filter)} />
      <SeriesBox series={rw.series} />
      <FailuresTable rows={filterFailures(rw.failures, filter)} />
    </>
  );
}

/** Notice for a source that failed or has no data. */
export function PoolNotice({ board }: { board: Board }) {
  const rw = board.pool;
  if (rw.state === 'loading') return null;
  return (
    <>
      {rw.state === 'error' && (
        <Alert severity={rw.source.mode === 'on' ? 'error' : 'info'} sx={{ mb: 1 }}>
          The runner service is not reachable ({rw.error}).{' '}
          {rw.source.mode === 'on'
            ? 'Check the runner service settings and the service proxy permission.'
            : 'The page shows the ARC feed instead. To use the runner service, check the settings and the service proxy permission, or turn it off here to hide this notice.'}
        </Alert>
      )}
      {rw.failed.length > 0 && rw.state === 'ok' && (
        <Alert severity="warning" sx={{ mb: 1 }}>
          {rw.failed.length === 1 ? 'One panel' : `${rw.failed.length} panels`} did not load:{' '}
          {rw.failed.map(f => `${f.id} (${f.reason})`).join(', ')}.
        </Alert>
      )}
    </>
  );
}

/**
 * The address of the runner service site, taken from the panel's own link. It is selectable text and
 * has no link: a link would open a new tab. Only an http or https address is shown.
 */
export function PoolLink({ board }: { board: Board }) {
  const link = board.pool.board?.panels.pools?.link;
  if (!link || !/^https?:\/\//i.test(link)) return null;
  return (
    <Typography variant="body2" component="span" title={link}>
      Runner service:{' '}
      <Box component="span" sx={{ userSelect: 'all', fontFamily: 'monospace' }}>
        {link}
      </Box>
    </Typography>
  );
}
