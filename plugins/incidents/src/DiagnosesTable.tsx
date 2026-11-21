import Box from '@mui/material/Box';
import Checkbox from '@mui/material/Checkbox';
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
import { CAUSE_LINES, diagnosesLayout, tableSx } from './tableLayout';

const STATUS_COLOUR: Record<Status, 'default' | 'info' | 'success' | 'error'> = {
  queued: 'default',
  running: 'info',
  done: 'success',
  failed: 'error',
};

function shortTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

/**
 * Confidence and source in one small line. A compact or narrow table has no columns for them, so the
 * line sits under the likely cause and no data is lost.
 */
function DetailLine({ d }: { d: DiagnosisSummary }) {
  const parts = [d.confidence ? `${d.confidence} confidence` : '', d.source].filter(Boolean);
  if (parts.length === 0) return null;
  return (
    <Box
      data-detail=""
      sx={{ fontSize: 12, color: 'text.secondary', overflowWrap: 'anywhere', mt: 0.25 }}
    >
      {parts.join(', ')}
    </Box>
  );
}

/** Checkboxes on the rows. The Incidents page turns them on. The dashboard list does not. */
export interface TableSelection {
  /** The selected ids. */
  ids: string[];
  /** A checkbox click, a Space key press, or a shift version of either (a range). */
  onToggle: (id: string, range: boolean) => void;
  /** The header checkbox: selects every shown row, or clears the shown rows when all are selected. */
  onToggleAll: () => void;
}

export interface DiagnosesTableProps {
  selection?: TableSelection;
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
  /**
   * A phone-wide container: three columns (time with severity, alert with cause, status). Nothing
   * is dropped and the table never needs a sideways scroll.
   */
  narrow?: boolean;
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
  narrow,
  disableNavigation,
  onRerun,
  touch,
  selection,
}: {
  narrow: boolean;
  selection?: TableSelection;
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
  const chosen = !!selection && selection.ids.includes(d.id);
  const name = d.alertName || d.id;
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
      selected={selected || chosen}
      data-incident-row={d.id}
      data-chosen={selection ? String(chosen) : undefined}
      // Space chooses the row and Shift+Space chooses a range. Enter opens the incident.
      tabIndex={selection ? 0 : undefined}
      onKeyDown={
        selection
          ? e => {
              if (e.target !== e.currentTarget) return;
              if (e.key === ' ') {
                e.preventDefault();
                selection.onToggle(d.id, e.shiftKey);
              } else if (e.key === 'Enter') {
                e.preventDefault();
                open();
              } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                const next =
                  e.key === 'ArrowDown'
                    ? e.currentTarget.nextElementSibling
                    : e.currentTarget.previousElementSibling;
                if (next instanceof HTMLElement) next.focus();
              }
            }
          : undefined
      }
      aria-selected={onSelect ? selected : undefined}
      sx={{ cursor: clickable ? 'pointer' : 'default' }}
      onClick={open}
    >
      {selection && (
        <TableCell padding="checkbox">
          <Checkbox
            size="small"
            checked={chosen}
            inputProps={{ 'aria-label': `Select ${name}` }}
            onClick={e => {
              e.stopPropagation();
              selection.onToggle(d.id, e.shiftKey);
            }}
            // The click handler decides. This keeps React from warning about a controlled box.
            onChange={() => undefined}
          />
        </TableCell>
      )}
      {narrow ? (
        <>
          <TableCell sx={{ whiteSpace: 'nowrap', px: 0.5, verticalAlign: 'top' }}>
            <Box title={formatTime(d.createdAt)}>{shortTime(d.createdAt)}</Box>
            <Chip
              size="small"
              label={d.severity || 'none'}
              color={severityColour(d.severity)}
              sx={{ mt: 0.5 }}
            />
          </TableCell>
          <TableCell sx={{ width: '100%', maxWidth: 0, px: 0.5, verticalAlign: 'top' }}>
            <Box sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {disableNavigation ? (
                name
              ) : (
                <Link
                  component={RouterLink}
                  to={diagnosisUrl(d.id)}
                  title={name}
                  onClick={e => e.stopPropagation()}
                >
                  {name}
                </Link>
              )}
            </Box>
            <Box
              title={d.likelyCause}
              sx={{
                fontSize: 13,
                color: 'text.secondary',
                display: '-webkit-box',
                WebkitLineClamp: 3,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
                overflowWrap: 'anywhere',
              }}
            >
              {d.likelyCause}
            </Box>
            <DetailLine d={d} />
          </TableCell>
          <TableCell sx={{ px: 0.5, verticalAlign: 'top' }}>
            <Chip
              size="small"
              variant="outlined"
              label={d.status}
              color={STATUS_COLOUR[d.status]}
            />
            {d.resolved && (
              <Box
                component="span"
                sx={{ display: 'block', fontSize: 12, color: 'text.secondary' }}
              >
                resolved
              </Box>
            )}
            {rerunButton && <Box sx={{ mt: 0.5 }}>{rerunButton}</Box>}
          </TableCell>
        </>
      ) : (
        <>
          <TableCell sx={selection ? { whiteSpace: 'nowrap' } : undefined}>
            {formatTime(d.createdAt)}
          </TableCell>
          <TableCell>
            {disableNavigation ? (
              d.alertName || d.id
            ) : (
              <Link
                component={RouterLink}
                to={diagnosisUrl(d.id)}
                onClick={e => e.stopPropagation()}
              >
                {d.alertName || d.id}
              </Link>
            )}
          </TableCell>
          <TableCell>
            <Chip size="small" label={d.severity || 'none'} color={severityColour(d.severity)} />
          </TableCell>
          <TableCell>
            <Chip
              size="small"
              variant="outlined"
              label={d.status}
              color={STATUS_COLOUR[d.status]}
            />
            {/* A narrow place has no room for the resolved column: the word sits under the status. */}
            {compact && d.resolved && (
              <Box
                component="span"
                sx={{ display: 'block', fontSize: 12, color: 'text.secondary' }}
              >
                resolved
              </Box>
            )}
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
              <DetailLine d={d} />
            </TableCell>
          ) : (
            // A wide place: the cause wraps in the width that the short columns leave, to six lines.
            <TableCell>
              <Box
                title={d.likelyCause}
                data-cause=""
                sx={{
                  display: '-webkit-box',
                  WebkitLineClamp: CAUSE_LINES,
                  WebkitBoxOrient: 'vertical',
                  overflow: 'hidden',
                  overflowWrap: 'anywhere',
                }}
              >
                {d.likelyCause}
              </Box>
            </TableCell>
          )}
          {!compact && <TableCell>{d.confidence}</TableCell>}
          {!compact && <TableCell>{d.source}</TableCell>}
          {!compact && <TableCell>{d.resolved ? 'yes' : 'no'}</TableCell>}
          {onRerun && !compact && <TableCell>{rerunButton}</TableCell>}
        </>
      )}
    </TableRow>
  );
}

/** The table of diagnoses. The Incidents page and the dashboard list widget both render it. */
export function DiagnosesTable(props: DiagnosesTableProps) {
  const compact = !!props.compact;
  const sel = props.selection;
  const shown = props.rows.length;
  const chosenShown = sel ? props.rows.filter(d => sel.ids.includes(d.id)).length : 0;
  const narrow = !!props.narrow;
  const headers = (
    narrow ? ['Time', 'Alert', 'Status'] : ['Time', 'Alert', 'Severity', 'Status', 'Likely cause']
  )
    .concat(compact || narrow ? [] : ['Confidence', 'Source', 'Resolved'])
    .concat(props.onRerun && !compact && !narrow ? ['Actions'] : []);
  return (
    <Table
      size={props.touch ? 'medium' : 'small'}
      stickyHeader={props.stickyHeader}
      sx={
        compact || narrow
          ? undefined
          : tableSx(diagnosesLayout({ checkbox: !!sel, detail: true, actions: !!props.onRerun }))
      }
    >
      <TableHead>
        <TableRow>
          {sel && (
            <TableCell padding="checkbox">
              <Checkbox
                size="small"
                checked={shown > 0 && chosenShown === shown}
                indeterminate={chosenShown > 0 && chosenShown < shown}
                disabled={shown === 0}
                inputProps={{ 'aria-label': 'Select all shown incidents' }}
                onChange={sel.onToggleAll}
              />
            </TableCell>
          )}
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
            narrow={narrow}
            disableNavigation={!!props.disableNavigation}
            onRerun={props.onRerun}
            touch={!!props.touch}
            selection={props.selection}
          />
        ))}
      </TableBody>
    </Table>
  );
}
