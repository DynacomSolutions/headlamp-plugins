import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Typography from '@mui/material/Typography';
import React from 'react';
import { IncidentSummaryCounts } from './model';

type Colour = 'default' | 'error' | 'warning' | 'info' | 'success';

function Group(props: { label: string; items: { label: string; n: number; colour: Colour }[] }) {
  return (
    <Box
      role="group"
      aria-label={props.label}
      sx={{ display: 'flex', alignItems: 'center', gap: 0.75, flexWrap: 'wrap' }}
    >
      <Typography variant="caption" color="text.secondary">
        {props.label}
      </Typography>
      {props.items.map(i => (
        <Chip
          key={i.label}
          size="small"
          variant={i.n > 0 ? 'filled' : 'outlined'}
          color={i.n > 0 ? i.colour : 'default'}
          label={`${i.n} ${i.label}`}
        />
      ))}
    </Box>
  );
}

/** Counts by severity and by status. */
export function IncidentSummary({ counts }: { counts: IncidentSummaryCounts }) {
  return (
    <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1.5, rowGap: 0.75 }}>
      <Typography variant="subtitle2" component="div">
        {counts.total} {counts.total === 1 ? 'incident' : 'incidents'}
      </Typography>
      <Group
        label="Severity"
        items={[
          { label: 'critical', n: counts.bySeverity.critical, colour: 'error' },
          { label: 'warning', n: counts.bySeverity.warning, colour: 'warning' },
          { label: 'other', n: counts.bySeverity.other, colour: 'default' },
        ]}
      />
      <Group
        label="Status"
        items={[
          { label: 'queued', n: counts.byStatus.queued, colour: 'default' },
          { label: 'running', n: counts.byStatus.running, colour: 'info' },
          { label: 'done', n: counts.byStatus.done, colour: 'success' },
          { label: 'failed', n: counts.byStatus.failed, colour: 'error' },
        ]}
      />
    </Box>
  );
}
