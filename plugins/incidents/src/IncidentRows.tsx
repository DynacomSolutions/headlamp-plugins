/*
 * The incident rows of the dashboard list: one tinted band for each incident. Critical rows come
 * first and carry a stronger tint and a square mark. The alert name is large, the cause takes two
 * lines, and the time and the analysis status sit at the right. A failed row has its Run again button.
 */
import Box from '@mui/material/Box';
import Link from '@mui/material/Link';
import { alpha, useTheme } from '@mui/material/styles';
import React from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { DiagnosisSummary, severityGroup, Status } from './model';
import { RerunButton } from './RerunButton';
import { diagnosisUrl } from './routes';
import { SeverityMark, useSeverityColours } from './severity';

export const STATUS_WORD: Record<Status, string> = {
  queued: 'Queued',
  running: 'Running',
  done: 'Analysed',
  failed: 'Analysis failed',
};

/** Critical first, then warning, then the rest. Rows of equal severity keep their order. */
export function bySeverityFirst(rows: DiagnosisSummary[]): DiagnosisSummary[] {
  const rank = { critical: 0, warning: 1, other: 2 } as const;
  return rows
    .map((d, i) => [d, i] as const)
    .sort(
      (a, b) =>
        rank[severityGroup(a[0].severity)] - rank[severityGroup(b[0].severity)] || a[1] - b[1]
    )
    .map(x => x[0]);
}

function formatTime(iso: string): { time: string; full: string } {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { time: iso, full: iso };
  return {
    time: d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    full: d.toLocaleString(),
  };
}

function Row(props: {
  d: DiagnosisSummary;
  selected: boolean;
  onSelect?: (d: DiagnosisSummary) => void;
  disableNavigation: boolean;
  onRerun?: (d: DiagnosisSummary) => Promise<void>;
  touch: boolean;
}): JSX.Element {
  const { d, selected, onSelect, disableNavigation, onRerun, touch } = props;
  const theme = useTheme();
  const colours = useSeverityColours();
  const sev = severityGroup(d.severity);
  const t = formatTime(d.createdAt);
  const dark = theme.palette.mode === 'dark';
  const tint =
    sev === 'critical'
      ? alpha(colours.critical, dark ? 0.26 : 0.14)
      : sev === 'warning'
      ? alpha(colours.warning, dark ? 0.1 : 0.08)
      : dark
      ? 'rgba(255,255,255,0.06)'
      : 'rgba(0,0,0,0.04)';
  const clickable = !!onSelect;
  return (
    <Box
      data-incident-row={d.id}
      data-severity-group={sev}
      aria-selected={onSelect ? selected : undefined}
      onClick={() => onSelect?.(d)}
      sx={{
        display: 'grid',
        gridTemplateColumns: '24px 1fr auto',
        columnGap: 1.75,
        alignItems: 'center',
        minHeight: touch ? 76 : 64,
        flex: 'none',
        px: 2,
        py: 1,
        borderRadius: 1,
        bgcolor: tint,
        cursor: clickable ? 'pointer' : 'default',
        outline: selected ? `2px solid ${theme.palette.text.primary}` : 'none',
        outlineOffset: -2,
      }}
    >
      <SeverityMark severity={sev} size={sev === 'critical' ? 22 : 18} />
      <Box sx={{ minWidth: 0 }}>
        <Box
          sx={{
            fontSize: 20,
            lineHeight: 1.15,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {disableNavigation ? (
            d.alertName || d.id
          ) : (
            <Link
              component={RouterLink}
              to={diagnosisUrl(d.id)}
              color="inherit"
              onClick={e => e.stopPropagation()}
            >
              {d.alertName || d.id}
            </Link>
          )}
        </Box>
        <Box
          title={d.likelyCause}
          sx={{
            mt: 0.5,
            fontSize: 14,
            lineHeight: 1.3,
            color: sev === 'critical' ? 'text.primary' : 'text.secondary',
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
            overflowWrap: 'anywhere',
          }}
        >
          {d.likelyCause}
        </Box>
      </Box>
      <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 0.5 }}>
        <Box
          title={t.full}
          sx={{ fontSize: 18, fontVariantNumeric: 'tabular-nums', lineHeight: 1 }}
        >
          {t.time}
        </Box>
        <Box
          data-status={d.status}
          sx={{ fontSize: 13, color: d.status === 'failed' ? colours.critical : 'text.secondary' }}
        >
          {STATUS_WORD[d.status]}
        </Box>
        {onRerun && d.status === 'failed' && (
          <RerunButton
            key={d.status}
            touch={touch}
            alertName={d.alertName || d.id}
            compact
            onRerun={() => onRerun(d)}
          />
        )}
      </Box>
    </Box>
  );
}

export function IncidentRows(props: {
  rows: DiagnosisSummary[];
  selectedId?: string | null;
  onSelect?: (d: DiagnosisSummary) => void;
  touch?: boolean;
  disableNavigation?: boolean;
  onRerun?: (d: DiagnosisSummary) => Promise<void>;
}): JSX.Element {
  const ordered = React.useMemo(() => bySeverityFirst(props.rows), [props.rows]);
  return (
    <Box
      data-incident-rows
      // The bottom space keeps the last card, with its Run again button, clear of the fade.
      sx={{ display: 'flex', flexDirection: 'column', gap: 0.75, pb: 1.5 }}
    >
      {ordered.map(d => (
        <Row
          key={d.id}
          d={d}
          selected={props.selectedId === d.id}
          onSelect={props.onSelect}
          disableNavigation={!!props.disableNavigation}
          onRerun={props.onRerun}
          touch={!!props.touch}
        />
      ))}
    </Box>
  );
}
