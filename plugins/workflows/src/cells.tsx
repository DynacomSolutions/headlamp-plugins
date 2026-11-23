/* Small cells that the page and the widget share. */
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import React from 'react';
import { formatAge, formatExact, HealthSummary, Row, Severity, Status, WorkloadRow } from './model';

export const STATUS_LABEL: Record<Status, string> = {
  ok: 'ok',
  failing: 'failing',
  overdue: 'overdue',
  'never run': 'never run',
  idle: 'idle',
  suspended: 'suspended',
};

/** Green ok, amber failing (1 or 2 in a row), red failing (3 or more) and overdue, grey the rest. */
export function statusColour(status: Status, severity: Severity): 'success' | 'warning' | 'error' | 'default' {
  if (status === 'ok') return 'success';
  if (status === 'overdue') return 'error';
  if (status === 'failing') return severity >= 3 ? 'error' : 'warning';
  return 'default';
}

export function StatusChip({ row }: { row: Pick<Row, 'status' | 'severity'> }): JSX.Element {
  const colour = statusColour(row.status, row.severity);
  return (
    <Chip
      size="small"
      label={STATUS_LABEL[row.status]}
      color={colour}
      variant={colour === 'default' ? 'outlined' : 'filled'}
    />
  );
}

/** A relative age with the exact local time in a tooltip. */
export function TimeCell({ ts, now }: { ts: number; now: number }): JSX.Element {
  if (!(ts > 0)) {
    return (
      <Typography variant="body2" color="text.secondary" component="span">
        -
      </Typography>
    );
  }
  return (
    <Tooltip title={formatExact(ts)}>
      <Typography variant="body2" component="span" sx={{ whiteSpace: 'nowrap' }}>
        {formatAge(ts, now)}
      </Typography>
    </Tooltip>
  );
}

/** The pods or components of a workflow, for a tooltip. */
export function instancesTitle(row: Row): string {
  if (row.instances.length <= 1) return '';
  return row.instances.map(i => `${i.label}: ${i.status}${i.failures > 0 ? ` (${i.failures} in a row)` : ''}`).join('\n');
}

export function workloadColour(row: Pick<WorkloadRow, 'status' | 'severity'>): 'success' | 'warning' | 'error' | 'default' {
  if (row.status === 'ok') return 'success';
  if (row.status === 'scaled to zero') return 'default';
  return row.severity >= 3 ? 'error' : 'warning';
}

export function WorkloadStatusChip({ row }: { row: Pick<WorkloadRow, 'status' | 'severity'> }): JSX.Element {
  const colour = workloadColour(row);
  return <Chip size="small" label={row.status} color={colour} variant={colour === 'default' ? 'outlined' : 'filled'} />;
}

/** The summary bar above the tables: what is failing right now. Red when a count is above 0. */
export function SummaryBar({ summary }: { summary: HealthSummary }): JSX.Element {
  const items: { label: string; count: number }[] = [
    { label: 'failing workflows', count: summary.failingWorkflows },
    { label: 'overdue workflows', count: summary.overdueWorkflows },
    { label: 'failing CronJobs', count: summary.failingCronJobs },
    { label: 'unhealthy workloads', count: summary.unhealthyWorkloads },
  ];
  return (
    <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'center' }} role="group" aria-label="Summary">
      {items.map(i => (
        <Chip
          key={i.label}
          size="small"
          label={`${i.count} ${i.label}`}
          color={i.count > 0 ? 'error' : 'success'}
          variant={i.count > 0 ? 'filled' : 'outlined'}
        />
      ))}
    </Box>
  );
}
