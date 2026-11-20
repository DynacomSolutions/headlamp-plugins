import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import Link from '@mui/material/Link';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import React from 'react';
import { Link as RouterLink, useHistory } from 'react-router-dom';
import { DiagnosisSummary, severityColour, Status } from './model';
import { RerunButton } from './RerunButton';
import { diagnosisUrl } from './routes';

const STATUS_COLOUR: Record<Status, 'default' | 'info' | 'success' | 'error'> = {
  queued: 'default',
  running: 'info',
  done: 'success',
  failed: 'error',
};

function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export interface DiagnosesTableProps {
  rows: DiagnosisSummary[];
  /**
   * Called when a row is clicked. Without it, a click opens the incident page. The alert name
   * link always opens the incident page.
   */
  onSelect?: (d: DiagnosisSummary) => void;
  /** The highlighted row. */
  selectedId?: string | null;
  /** Hides the confidence, source and resolved columns, for a narrow container. */
  compact?: boolean;
  /** A bigger touch target per row. */
  touch?: boolean;
  /** The header stays at the top of the scroll container. */
  stickyHeader?: boolean;
  /** Turns the links and the page-opening click off (dashboard edit mode). */
  disableNavigation?: boolean;
  /**
   * Runs a failed diagnosis again. With it, each failed row has a "Run again" button. The promise
   * resolves when the agent has queued the run and the parent has fetched the rows again.
   */
  onRerun?: (d: DiagnosisSummary) => Promise<void>;
}

function Row({
  d,
  onSelect,
  selected,
  compact,
  disableNavigation,
  onRerun,
  touch,
}: {
  d: DiagnosisSummary;
  onSelect?: (d: DiagnosisSummary) => void;
  selected: boolean;
  compact: boolean;
  disableNavigation: boolean;
  onRerun?: (d: DiagnosisSummary) => Promise<void>;
  touch: boolean;
}) {
  const history = useHistory();
  const open = () => {
    if (onSelect) onSelect(d);
    else if (!disableNavigation) history.push(diagnosisUrl(d.id));
  };
  const clickable = !!onSelect || !disableNavigation;
  const rerunButton =
    onRerun && d.status === 'failed' ? (
      <RerunButton
        key={d.status}
        touch={touch}
        alertName={d.alertName || d.id}
        compact={compact}
        onRerun={() => onRerun(d)}
      />
    ) : null;
  return (
    <TableRow
      hover={clickable}
      selected={selected}
      aria-selected={onSelect ? selected : undefined}
      sx={{ cursor: clickable ? 'pointer' : 'default' }}
      onClick={open}
    >
      <TableCell>{formatTime(d.createdAt)}</TableCell>
      <TableCell>
        {disableNavigation ? (
          d.alertName || d.id
        ) : (
          <Link component={RouterLink} to={diagnosisUrl(d.id)} onClick={e => e.stopPropagation()}>
            {d.alertName || d.id}
          </Link>
        )}
      </TableCell>
      <TableCell>
        <Chip size="small" label={d.severity || 'none'} color={severityColour(d.severity)} />
      </TableCell>
      <TableCell>
        <Chip size="small" variant="outlined" label={d.status} color={STATUS_COLOUR[d.status]} />
        {/* A narrow widget has no room for a column: the button sits under the status. */}
        {compact && rerunButton && <Box sx={{ mt: 0.5 }}>{rerunButton}</Box>}
      </TableCell>
      {compact ? (
        // A narrow widget: the cause takes the rest of the row and wraps to three lines at most.
        <TableCell sx={{ width: '100%', maxWidth: 0, minWidth: 140 }}>
          <Box
            title={d.likelyCause}
            sx={{
              display: '-webkit-box',
              WebkitLineClamp: 3,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
              overflowWrap: 'anywhere',
            }}
          >
            {d.likelyCause}
          </Box>
        </TableCell>
      ) : (
        <TableCell sx={{ maxWidth: 480 }}>{d.likelyCause}</TableCell>
      )}
      {!compact && <TableCell>{d.confidence}</TableCell>}
      {!compact && <TableCell>{d.source}</TableCell>}
      {!compact && <TableCell>{d.resolved ? 'yes' : 'no'}</TableCell>}
      {onRerun && !compact && <TableCell>{rerunButton}</TableCell>}
    </TableRow>
  );
}

/** The table of diagnoses. The Incidents page and the dashboard list widget both render it. */
export function DiagnosesTable(props: DiagnosesTableProps) {
  const compact = !!props.compact;
  const headers = ['Time', 'Alert', 'Severity', 'Status', 'Likely cause']
    .concat(compact ? [] : ['Confidence', 'Source', 'Resolved'])
    .concat(props.onRerun && !compact ? ['Actions'] : []);
  return (
    <Table size={props.touch ? 'medium' : 'small'} stickyHeader={props.stickyHeader}>
      <TableHead>
        <TableRow>
          {headers.map(h => (
            <TableCell key={h}>{h}</TableCell>
          ))}
        </TableRow>
      </TableHead>
      <TableBody>
        {props.rows.map(d => (
          <Row
            key={d.id}
            d={d}
            onSelect={props.onSelect}
            selected={props.selectedId === d.id}
            compact={compact}
            disableNavigation={!!props.disableNavigation}
            onRerun={props.onRerun}
            touch={!!props.touch}
          />
        ))}
      </TableBody>
    </Table>
  );
}
