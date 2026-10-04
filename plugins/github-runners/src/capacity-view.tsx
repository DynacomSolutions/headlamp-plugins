import { CommonComponents } from '@kinvolk/headlamp-plugin/lib';
const { SectionBox, StatusLabel, Table } = CommonComponents;
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import React from 'react';
import {
  buildCapacity,
  Capacity,
  formatCpu,
  formatMemory,
  NodeUsage,
  PoolRow,
  Resources,
} from './capacity';
import type { Board } from './data';

function Empty({ text }: { text: string }) {
  return <Typography sx={{ p: 2 }}>{text}</Typography>;
}

function Stack({ node, field }: { node: NodeUsage; field: keyof Resources }) {
  const total = node.allocatable[field];
  if (total <= 0) return <>-</>;
  const pct = (v: number) => Math.min(100, Math.max(0, (v / total) * 100));
  const fmt = field === 'cpu' ? formatCpu : formatMemory;
  const runner = pct(node.runner[field]);
  const other = Math.min(pct(node.other[field]), 100 - runner);
  const label = `${fmt(node.runner[field])} runners, ${fmt(node.other[field])} other, ${fmt(
    node.free[field]
  )} free of ${fmt(total)}`;
  return (
    <Tooltip title={label}>
      <Box
        role="img"
        aria-label={label}
        sx={{
          display: 'flex',
          width: 160,
          height: 12,
          borderRadius: '2px',
          overflow: 'hidden',
          bgcolor: 'action.disabledBackground',
        }}
      >
        <Box sx={{ width: `${runner}%`, bgcolor: 'warning.main' }} />
        <Box sx={{ width: `${other}%`, bgcolor: 'info.main' }} />
      </Box>
    </Tooltip>
  );
}

function PoolsTable({ cap }: { cap: Capacity }) {
  return (
    <SectionBox title={`Pools (${cap.pools.length})`}>
      {cap.pools.length === 0 ? (
        <Empty text="No AutoscalingRunnerSets found." />
      ) : (
        <Table
          data={cap.pools}
          columns={[
            {
              header: 'Pool',
              accessorFn: (p: PoolRow) => p.name,
              Cell: ({ row }: any) => {
                const p: PoolRow = row.original;
                return (
                  <Box display="flex" gap={1} alignItems="center">
                    <Typography variant="body2" color={p.violations.length ? 'error' : undefined}>
                      {p.name}
                    </Typography>
                    {p.violations.length > 0 && (
                      <Tooltip title={p.violations.join('; ')}>
                        <span>
                          <StatusLabel status="error">policy</StatusLabel>
                        </span>
                      </Tooltip>
                    )}
                  </Box>
                );
              },
            },
            { header: 'Serves', accessorFn: (p: PoolRow) => p.serves },
            { header: 'Cap', accessorFn: (p: PoolRow) => p.cap },
            { header: 'Running', accessorFn: (p: PoolRow) => p.running },
            {
              header: 'Waiting to start',
              accessorFn: (p: PoolRow) => p.pending,
              Cell: ({ row }: any) => {
                const p: PoolRow = row.original;
                if (!p.pending) return <>0</>;
                return (
                  <StatusLabel status={p.starved ? 'error' : 'warning'}>
                    {p.pending}
                    {p.pendingReason ? `: ${p.pendingReason}` : ''}
                  </StatusLabel>
                );
              },
            },
            {
              header: 'Preferred nodes',
              accessorFn: (p: PoolRow) => p.preferred.join(', ') || '-',
            },
            {
              header: 'Spill nodes',
              accessorFn: (p: PoolRow) =>
                p.spillAny ? 'any other node' : p.spill.join(', ') || 'none',
            },
          ]}
        />
      )}
    </SectionBox>
  );
}

function NodesTable({ cap }: { cap: Capacity }) {
  return (
    <SectionBox title={`Nodes (${cap.nodes.length})`}>
      {cap.nodes.length === 0 ? (
        <Empty text="No Kubernetes nodes visible." />
      ) : (
        <Table
          data={cap.nodes}
          columns={[
            { header: 'Node', accessorFn: (n: NodeUsage) => n.name },
            {
              header: 'CPU (runners / other / total)',
              accessorFn: (n: NodeUsage) => n.allocatable.cpu,
              Cell: ({ row }: any) => {
                const n: NodeUsage = row.original;
                return (
                  <Box>
                    <Stack node={n} field="cpu" />
                    <Typography variant="caption" display="block">
                      {formatCpu(n.runner.cpu)} / {formatCpu(n.other.cpu)} / {formatCpu(n.allocatable.cpu)}
                      , free {formatCpu(n.free.cpu)}
                    </Typography>
                  </Box>
                );
              },
            },
            {
              header: 'Memory (runners / other / total)',
              accessorFn: (n: NodeUsage) => n.allocatable.memory,
              Cell: ({ row }: any) => {
                const n: NodeUsage = row.original;
                return (
                  <Box>
                    <Stack node={n} field="memory" />
                    <Typography variant="caption" display="block">
                      {formatMemory(n.runner.memory)} / {formatMemory(n.other.memory)} /{' '}
                      {formatMemory(n.allocatable.memory)}, free {formatMemory(n.free.memory)}
                    </Typography>
                  </Box>
                );
              },
            },
            {
              header: 'Runners now',
              accessorFn: (n: NodeUsage) => n.pools.reduce((a, p) => a + p.count, 0),
              Cell: ({ row }: any) => {
                const n: NodeUsage = row.original;
                return <>{n.pools.map(p => `${p.pool} x${p.count}`).join(', ') || '-'}</>;
              },
            },
          ]}
        />
      )}
    </SectionBox>
  );
}

function DemandBox({ cap }: { cap: Capacity }) {
  const { demand, capacity, short } = cap.demand;
  const starved = cap.pools.filter(p => p.starved);
  const rows = [
    { resource: 'CPU', demand: formatCpu(demand.cpu), capacity: formatCpu(capacity.cpu), short: short.cpu },
    {
      resource: 'Memory',
      demand: formatMemory(demand.memory),
      capacity: formatMemory(capacity.memory),
      short: short.memory,
    },
  ];
  return (
    <SectionBox title="Demand versus capacity">
      {short.cpu && (
        <Alert severity="warning" sx={{ m: 1 }}>
          Demand at cap ({formatCpu(demand.cpu)}) exceeds the CPU the pools can use (
          {formatCpu(capacity.cpu)}). Runners may be left waiting at full load.
        </Alert>
      )}
      {short.memory && (
        <Alert severity="warning" sx={{ m: 1 }}>
          Demand at cap ({formatMemory(demand.memory)}) exceeds the memory the pools can use (
          {formatMemory(capacity.memory)}). Runners may be left waiting at full load.
        </Alert>
      )}
      {starved.map(p => (
        <Alert key={p.name} severity="error" sx={{ m: 1 }}>
          Pool {p.name} is starved: {p.pending} waiting to start and none running
          {p.pendingReason ? ` (${p.pendingReason})` : ''}.
        </Alert>
      ))}
      <Table
        data={rows}
        columns={[
          { header: 'Resource', accessorFn: (r: any) => r.resource },
          { header: 'Demand at cap', accessorFn: (r: any) => r.demand },
          { header: 'Capacity', accessorFn: (r: any) => r.capacity },
          {
            header: 'Result',
            accessorFn: (r: any) => (r.short ? 'short' : 'enough'),
            Cell: ({ row }: any) => (
              <StatusLabel status={row.original.short ? 'error' : 'success'}>
                {row.original.short ? 'demand exceeds capacity' : 'enough'}
              </StatusLabel>
            ),
          },
        ]}
      />
      <Typography variant="caption" color="text.secondary" display="block" sx={{ p: 1 }}>
        Demand is each pool&apos;s cap multiplied by its per-runner requests. Capacity is the
        allocatable resources of every node a pool can run on, minus what non-runner pods request.
      </Typography>
    </SectionBox>
  );
}

function ExternalBox({ cap }: { cap: Capacity }) {
  return (
    <SectionBox title={`Runners outside the cluster (${cap.external.length})`}>
      {cap.external.length === 0 ? (
        <Empty text="No external runners reported." />
      ) : (
        <Table
          data={cap.external}
          columns={[
            { header: 'Runner', accessorFn: (e: any) => e.name },
            { header: 'OS', accessorFn: (e: any) => e.os },
            {
              header: 'Status',
              accessorFn: (e: any) => (e.state === 'standby' ? 'standby' : e.online ? 'online' : 'offline'),
              Cell: ({ row }: any) => {
                const e = row.original;
                if (e.state === 'standby') {
                  return (
                    <Tooltip title={e.reason}>
                      <span>
                        <StatusLabel status="">standby</StatusLabel>
                      </span>
                    </Tooltip>
                  );
                }
                return (
                  <StatusLabel status={e.online ? 'success' : 'error'}>
                    {e.online ? 'online' : 'offline'}
                  </StatusLabel>
                );
              },
            },
            { header: 'Activity', accessorFn: (e: any) => (e.busy ? 'busy' : 'idle') },
            { header: 'Note', accessorFn: (e: any) => e.reason || '-' },
          ]}
        />
      )}
    </SectionBox>
  );
}

function PolicyBox({ cap }: { cap: Capacity }) {
  if (!cap.policy.configured) {
    return (
      <SectionBox title="Policy check">
        <Alert severity="info" sx={{ m: 1 }}>
          No policy is configured. Set preferred nodes, spill nodes or repo caps in this
          plugin&apos;s settings to check every pool against them.
        </Alert>
      </SectionBox>
    );
  }
  const bad = cap.pools.filter(p => p.violations.length > 0);
  return (
    <SectionBox title={`Policy check (${cap.violationCount} violation${cap.violationCount === 1 ? '' : 's'})`}>
      {bad.length === 0 ? (
        <Alert severity="success" sx={{ m: 1 }}>
          Every pool complies with the configured policy.
        </Alert>
      ) : (
        <Table
          data={bad}
          columns={[
            { header: 'Pool', accessorFn: (p: PoolRow) => p.name },
            { header: 'Serves', accessorFn: (p: PoolRow) => p.serves },
            {
              header: 'Reasons',
              accessorFn: (p: PoolRow) => p.violations.join('; '),
              Cell: ({ row }: any) => (
                <Box>
                  {(row.original as PoolRow).violations.map(v => (
                    <Typography key={v} variant="body2" color="error">
                      {v}
                    </Typography>
                  ))}
                </Box>
              ),
            },
          ]}
        />
      )}
    </SectionBox>
  );
}

/** Capacity tab. Everything derives from watched lists and the polled status, so it updates live. */
export function CapacityView({ board }: { board: Board }) {
  const { lists } = board;
  const cap = React.useMemo(
    () =>
      buildCapacity({
        nodes: board.nodes,
        pods: board.pods,
        runners: lists.runners.items,
        scaleSets: lists.sets.items,
        externalWorkers: board.workers,
        status: board.status,
        cfg: board.cfg,
      }),
    [board.nodes, board.pods, lists.runners.items, lists.sets.items, board.workers, board.status, board.cfg]
  );
  return (
    <>
      {lists.sets.absent && (
        <Alert severity="info" sx={{ mb: 1 }}>
          AutoscalingRunnerSets are not available (ARC CRDs not installed or not visible), so
          pools, demand and policy are empty. Node usage and external runners still show.
        </Alert>
      )}
      <PoolsTable cap={cap} />
      <NodesTable cap={cap} />
      <DemandBox cap={cap} />
      <ExternalBox cap={cap} />
      <PolicyBox cap={cap} />
    </>
  );
}
