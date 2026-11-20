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
}

function Row({
  d,
  onSelect,
  selected,
  compact,
  disableNavigation,
}: {
  d: DiagnosisSummary;
  onSelect?: (d: DiagnosisSummary) => void;
  selected: boolean;
  compact: boolean;
  disableNavigation: boolean;
}) {
  const history = useHistory();
  const open = () => {
    if (onSelect) onSelect(d);
    else if (!disableNavigation) history.push(diagnosisUrl(d.id));
  };
  const clickable = !!onSelect || !disableNavigation;
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
      </TableCell>
      <TableCell sx={{ maxWidth: 480 }}>{d.likelyCause}</TableCell>
      {!compact && <TableCell>{d.confidence}</TableCell>}
      {!compact && <TableCell>{d.source}</TableCell>}
      {!compact && <TableCell>{d.resolved ? 'yes' : 'no'}</TableCell>}
    </TableRow>
  );
}

/** The table of diagnoses. The Incidents page and the dashboard list widget both render it. */
export function DiagnosesTable(props: DiagnosesTableProps) {
  const compact = !!props.compact;
  const headers = ['Time', 'Alert', 'Severity', 'Status', 'Likely cause'].concat(
    compact ? [] : ['Confidence', 'Source', 'Resolved']
  );
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
          />
        ))}
      </TableBody>
    </Table>
  );
}
