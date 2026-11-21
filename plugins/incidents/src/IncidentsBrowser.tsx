/*
 * The list on the Incidents page: filters, a fixed selection bar and one scrolling table. The user
 * can select several incidents and open one chat about all of them. The filters and the selection
 * live in the query string and change the history entry with replace, so Back leaves the page and
 * the URL alone shows the same view again.
 */
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import FormControlLabel from '@mui/material/FormControlLabel';
import MenuItem from '@mui/material/MenuItem';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import React from 'react';
import { useHistory, useLocation } from 'react-router-dom';
import { createIncidentsChat } from './chat-data';
import { cleanErrorText } from './chat-model';
import { useSettings } from './data';
import { DiagnosesTable } from './DiagnosesTable';
import { DiagnosisSummary, filterDiagnoses } from './model';
import {
  clearShown,
  DEFAULT_LIST_QUERY,
  ListQuery,
  listQueryString,
  matchesText,
  MAX_CHAT_INCIDENTS,
  parseListQuery,
  pruneIds,
  rangeIds,
  selectAllIds,
  SelectionResult,
  toggleId,
} from './multiselect';
import { chatUrl } from './routes';
import { ScrollArea } from './ScrollArea';
import { useFillHeight } from './useFillHeight';

/**
 * Below this width the table has no columns for confidence, source, resolved and the button: they
 * move under the status and the likely cause. All nine columns need about 880 px (the likely cause
 * keeps 18 characters). A 1280 px window with the sidebar open gives the table 960 px, so the
 * full table shows there. The old limit of 1100 px hid four columns at that width.
 */
export const COMPACT_BELOW = 900;
/** Below this width the table stacks to three columns, so a phone needs no sideways scroll. */
export const NARROW_BELOW = 860;

const STATUS_OPTIONS = [
  { value: 'all', label: 'All statuses' },
  { value: 'queued', label: 'Queued' },
  { value: 'running', label: 'Running' },
  { value: 'done', label: 'Analysed' },
  { value: 'failed', label: 'Analysis failed' },
];
const SEVERITY_OPTIONS = [
  { value: 'all', label: 'All severities' },
  { value: 'critical', label: 'Critical' },
  { value: 'warning', label: 'Warning' },
  { value: 'other', label: 'Info, none and unrated' },
];

function useWidth(): [(node: HTMLElement | null) => void, number | null] {
  const [node, setNode] = React.useState<HTMLElement | null>(null);
  const [width, setWidth] = React.useState<number | null>(null);
  React.useEffect(() => {
    if (!node) return undefined;
    const measure = () => setWidth(Math.round(node.getBoundingClientRect().width));
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(node);
    return () => ro.disconnect();
  }, [node]);
  return [setNode, width];
}

export function IncidentsBrowser(props: {
  rows: DiagnosisSummary[];
  onRerun?: (d: DiagnosisSummary) => Promise<void>;
}) {
  const { rows, onRerun } = props;
  const settings = useSettings();
  const history = useHistory();
  const location = useLocation();
  const query = React.useMemo(() => parseListQuery(location.search), [location.search]);
  const anchor = React.useRef<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const fill = useFillHeight();
  const [widthRef, width] = useWidth();

  const setQuery = (next: ListQuery) => {
    const search = listQueryString(next);
    if (search !== location.search) {
      history.replace({ pathname: location.pathname, search, hash: location.hash });
    }
  };

  const shown = React.useMemo(
    () => filterDiagnoses(rows, query).filter(d => matchesText(d, query.q)),
    [rows, query]
  );
  const order = React.useMemo(() => shown.map(d => d.id), [shown]);
  // An id that no diagnosis has any more is not selected.
  const selected = React.useMemo(
    () =>
      pruneIds(
        query.sel,
        rows.map(d => d.id)
      ),
    [query.sel, rows]
  );
  const hidden = selected.filter(id => !order.includes(id)).length;

  const apply = (r: SelectionResult, anchorId: string | null) => {
    anchor.current = anchorId;
    setNotice(
      r.capped
        ? `A chat holds at most ${MAX_CHAT_INCIDENTS} incidents. The first ones are selected.`
        : null
    );
    setQuery({ ...query, sel: r.ids });
  };
  const onToggle = (id: string, range: boolean) =>
    apply(
      range && anchor.current
        ? rangeIds(selected, order, anchor.current, id)
        : toggleId(selected, id),
      id
    );
  const selectAll = () => apply(selectAllIds(selected, order), anchor.current);
  const clearAll = () => apply({ ids: [], capped: false }, null);
  const chosenShown = order.filter(id => selected.includes(id)).length;
  const onToggleAll = () => {
    const full = chosenShown >= Math.min(order.length, MAX_CHAT_INCIDENTS);
    if (chosenShown > 0 && full) apply({ ids: clearShown(selected, order), capped: false }, null);
    else selectAll();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    const target = e.target as HTMLElement;
    // In the search box, Escape first clears the text.
    if (target instanceof HTMLInputElement && target.type === 'text' && query.q) {
      setQuery({ ...query, q: '' });
      return;
    }
    if (selected.length > 0) {
      e.preventDefault();
      clearAll();
    }
  };

  const chat = async () => {
    setBusy(true);
    setError(null);
    try {
      const id = await createIncidentsChat(settings, selected);
      history.push(chatUrl(id));
    } catch (e) {
      setError(cleanErrorText(e));
    } finally {
      setBusy(false);
    }
  };

  const n = selected.length;
  // Unmeasured (or zero wide, as in a test) means not compact, so the first paint does not flip.
  const compact = width !== null && width > 0 && width < COMPACT_BELOW;
  const narrow = width !== null && width > 0 && width < NARROW_BELOW;
  return (
    <Box
      ref={fill.ref}
      onKeyDown={onKeyDown}
      data-incidents-browser
      sx={{
        display: 'flex',
        flexDirection: 'column',
        gap: 1,
        height: fill.height ?? 'calc(100vh - 220px)',
        minHeight: 360,
      }}
    >
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, alignItems: 'center', flex: 'none' }}>
        <TextField
          select
          size="small"
          label="Status"
          value={query.status}
          onChange={e => setQuery({ ...query, status: e.target.value as ListQuery['status'] })}
          sx={{ minWidth: 150 }}
        >
          {STATUS_OPTIONS.map(o => (
            <MenuItem key={o.value} value={o.value}>
              {o.label}
            </MenuItem>
          ))}
        </TextField>
        <TextField
          select
          size="small"
          label="Severity"
          value={query.severity}
          onChange={e => setQuery({ ...query, severity: e.target.value as ListQuery['severity'] })}
          sx={{ minWidth: 190 }}
        >
          {SEVERITY_OPTIONS.map(o => (
            <MenuItem key={o.value} value={o.value}>
              {o.label}
            </MenuItem>
          ))}
        </TextField>
        <TextField
          size="small"
          type="text"
          label="Search"
          value={query.q}
          onChange={e => setQuery({ ...query, q: e.target.value })}
          sx={{ flex: '1 1 160px', minWidth: 120, maxWidth: 320 }}
        />
        <FormControlLabel
          label="Open only"
          control={
            <Checkbox
              size="small"
              checked={query.openOnly}
              onChange={e => setQuery({ ...query, openOnly: e.target.checked })}
            />
          }
        />
        {(query.status !== 'all' || query.severity !== 'all' || query.openOnly || query.q) && (
          <Button
            size="small"
            color="inherit"
            onClick={() => setQuery({ ...DEFAULT_LIST_QUERY, sel: query.sel })}
          >
            Reset filters
          </Button>
        )}
      </Box>
      <Box
        role="toolbar"
        aria-label="Selection"
        sx={theme => ({
          flex: 'none',
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: 1,
          px: 1,
          py: 0.5,
          minHeight: 44,
          borderRadius: 1,
          backgroundColor: n > 0 ? theme.palette.action.selected : theme.palette.action.hover,
        })}
      >
        <Typography variant="body2" component="span" aria-live="polite" sx={{ fontWeight: 500 }}>
          {n > 0 ? `${n} selected` : `${shown.length} shown`}
          {hidden > 0 ? `, ${hidden} hidden by the filters` : ''}
        </Typography>
        {n > 0 && (
          <Button size="small" color="inherit" onClick={clearAll}>
            Clear
          </Button>
        )}
        <Button
          size="small"
          color="inherit"
          onClick={selectAll}
          disabled={order.length === 0 || chosenShown >= Math.min(order.length, MAX_CHAT_INCIDENTS)}
        >
          {`Select all ${
            Math.min(order.length, MAX_CHAT_INCIDENTS) === order.length
              ? order.length
              : `first ${MAX_CHAT_INCIDENTS} of ${order.length}`
          } shown`}
        </Button>
        <Box sx={{ flex: 1 }} />
        <Button
          size="small"
          variant="contained"
          disabled={n === 0 || busy}
          onClick={chat}
          sx={{ textTransform: 'none' }}
        >
          {n === 1 ? 'Chat about 1 incident' : `Chat about ${n} incidents`}
        </Button>
      </Box>
      {notice && (
        <Alert severity="info" onClose={() => setNotice(null)} sx={{ flex: 'none' }}>
          {notice}
        </Alert>
      )}
      {error && (
        <Alert severity="error" onClose={() => setError(null)} sx={{ flex: 'none' }}>
          Could not start a chat: {error}
        </Alert>
      )}
      <Box ref={widthRef} sx={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {shown.length === 0 ? (
          <Typography color="text.secondary" sx={{ p: 1 }}>
            No diagnoses match the filters.
          </Typography>
        ) : (
          <ScrollArea label="Diagnoses" sx={{ overflowX: 'auto', touchAction: 'pan-x pan-y' }}>
            <DiagnosesTable
              rows={shown}
              onRerun={onRerun}
              compact={compact}
              narrow={narrow}
              stickyHeader
              selection={{ ids: selected, onToggle, onToggleAll }}
            />
          </ScrollArea>
        )}
      </Box>
    </Box>
  );
}
