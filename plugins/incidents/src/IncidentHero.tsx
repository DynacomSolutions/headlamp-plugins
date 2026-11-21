/*
 * The head of the incident list on a dashboard: the critical count in very large type, then the
 * warning counts and one count for each other severity by its own name (such as info), and the
 * failed analyses at the right. The status counts follow in one
 * quiet line. Every count has a shape and a word, never colour alone.
 */
import Box from '@mui/material/Box';
import React from 'react';
import { IncidentSummaryCounts } from './model';
import { SeverityGroup, SeverityMark, useSeverityColours } from './severity';

function Count(props: {
  n: number;
  label: string;
  severity?: SeverityGroup;
  big?: boolean;
  alert?: boolean;
}): JSX.Element {
  const colours = useSeverityColours();
  const { n, label, severity, big, alert } = props;
  const loud = (big && n > 0) || (alert && n > 0);
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', lineHeight: 1, minWidth: 0 }}>
      <Box
        component="strong"
        data-count={label}
        sx={{
          fontWeight: 600,
          fontVariantNumeric: 'tabular-nums',
          fontSize: big ? 'clamp(56px, 11cqw, 104px)' : 'clamp(28px, 4.6cqw, 44px)',
          letterSpacing: big ? '-0.02em' : 0,
          color: loud ? colours.critical : 'text.primary',
        }}
      >
        {n}
      </Box>
      <Box
        component="span"
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          mt: 0.75,
          color: 'text.secondary',
          fontSize: big ? 17 : 15,
        }}
      >
        {severity && <SeverityMark severity={severity} size={big ? 22 : 18} />}
        {label}
      </Box>
    </Box>
  );
}

export function IncidentHero({ counts }: { counts: IncidentSummaryCounts }): JSX.Element {
  const s = counts.byStatus;
  return (
    <Box sx={{ containerType: 'inline-size', flex: 'none', pt: 1.25 }}>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'flex-end',
          gap: 'clamp(14px, 3cqw, 26px)',
          px: 0.75,
          pb: 1.25,
        }}
      >
        <Count n={counts.bySeverity.critical} label="critical" severity="critical" big />
        <Count n={counts.bySeverity.warning} label="warning" severity="warning" />
        {counts.lower.map(l => (
          <Count key={l.name} n={l.n} label={l.name} />
        ))}
        <Box sx={{ ml: 'auto' }}>
          <Count n={s.failed} label="failed analyses" alert />
        </Box>
      </Box>
      <Box sx={{ px: 0.75, pb: 1, color: 'text.secondary', fontSize: 13 }}>
        {counts.total} {counts.total === 1 ? 'incident' : 'incidents'}. {s.queued} queued,{' '}
        {s.running} running, {s.done} done, {s.failed} failed.
      </Box>
    </Box>
  );
}
