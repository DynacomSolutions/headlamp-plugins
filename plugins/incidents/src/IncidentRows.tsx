/*
 * The incident rows of the dashboard list, grouped by alert name. A group header shows the alert
 * name, the number of incidents, the worst severity (a shape and a word) and the status mix. Only
 * the groups show at first: a click on a header opens its incidents. Critical groups come first.
 * With a chat widget on the page, a header also has a "Chat about this group" button. It selects
 * the group for the chat, and the chevron side of the header still only opens and closes the group.
 *
 * An incident row is one tinted band with the cause on one line (the full text is on hover), the
 * time and the analysis status. A failed row has its Run again button. In a narrow widget the
 * status word of an analysed row is hidden, because the group header holds the status mix. The
 * width is the width of the widget (a ResizeObserver), not the width of the window.
 */
import Box from '@mui/material/Box';
import Link from '@mui/material/Link';
import { alpha, useTheme } from '@mui/material/styles';
import React from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { DiagnosisSummary, severityGroup, Status } from './model';
import { RerunButton } from './RerunButton';
import { diagnosisUrl } from './routes';
import { SEVERITY_WORD, SeverityGroup, SeverityMark, useSeverityColours } from './severity';
import { useElementWidth } from './useElementWidth';

export const STATUS_WORD: Record<Status, string> = {
  queued: 'Queued',
  running: 'Running',
  done: 'Analysed',
  failed: 'Analysis failed',
};

/** The status words of a group header. They are lower case, so they read as a list. */
const STATUS_MIX_WORD: Record<Status, string> = {
  failed: 'failed',
  running: 'running',
  queued: 'queued',
  done: 'analysed',
};

/** Statuses in the order a header lists them: what needs attention comes first. */
const STATUS_ORDER: Status[] = ['failed', 'running', 'queued', 'done'];

/** A widget narrower than this (in px) hides the status word of an analysed row. */
export const NARROW_BELOW = 520;

const SEVERITY_RANK: Record<SeverityGroup, number> = { critical: 0, warning: 1, other: 2 };

/** The name of the group for an alert that has no name. */
export const UNNAMED_ALERT = 'Unnamed alert';

/** Critical first, then warning, then the rest. Rows of equal severity keep their order. */
export function bySeverityFirst(rows: DiagnosisSummary[]): DiagnosisSummary[] {
  return rows
    .map((d, i) => [d, i] as const)
    .sort(
      (a, b) =>
        SEVERITY_RANK[severityGroup(a[0].severity)] - SEVERITY_RANK[severityGroup(b[0].severity)] ||
        a[1] - b[1]
    )
    .map(x => x[0]);
}

export interface IncidentGroup {
  /** The alert name, the key of the group. */
  name: string;
  /** The incidents of the alert, critical first, each severity in the order it arrived. */
  rows: DiagnosisSummary[];
  /** The most severe incident in the group. */
  worst: SeverityGroup;
  byStatus: Record<Status, number>;
}

/**
 * Groups the incidents by alert name. Every alert name is its own group, with no catch-all group.
 * Groups with the worst severity come first, then the groups with more incidents, then by name.
 */
export function groupByAlert(rows: DiagnosisSummary[]): IncidentGroup[] {
  const groups = new Map<string, IncidentGroup>();
  for (const d of bySeverityFirst(rows)) {
    const name = d.alertName.trim() || UNNAMED_ALERT;
    let g = groups.get(name);
    if (!g) {
      g = {
        name,
        rows: [],
        worst: severityGroup(d.severity),
        byStatus: { queued: 0, running: 0, done: 0, failed: 0 },
      };
      groups.set(name, g);
    }
    g.rows.push(d);
    g.byStatus[d.status] += 1;
  }
  return [...groups.values()].sort(
    (a, b) =>
      SEVERITY_RANK[a.worst] - SEVERITY_RANK[b.worst] ||
      b.rows.length - a.rows.length ||
      a.name.localeCompare(b.name)
  );
}

/** The status mix of a group as text, for example `98 analysed, 1 failed`. */
export function statusMixText(byStatus: Record<Status, number>): string {
  return STATUS_ORDER.filter(s => byStatus[s] > 0)
    .map(s => `${byStatus[s]} ${STATUS_MIX_WORD[s]}`)
    .join(', ');
}

function formatTime(iso: string): { time: string; full: string } {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { time: iso, full: iso };
  return {
    time: d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    full: d.toLocaleString(),
  };
}

function useTint(): (sev: SeverityGroup, strength: number) => string {
  const theme = useTheme();
  const colours = useSeverityColours();
  const dark = theme.palette.mode === 'dark';
  return (sev, strength) =>
    sev === 'critical'
      ? alpha(colours.critical, (dark ? 0.26 : 0.14) * strength)
      : sev === 'warning'
      ? alpha(colours.warning, (dark ? 0.1 : 0.08) * strength)
      : dark
      ? `rgba(255,255,255,${0.06 * strength})`
      : `rgba(0,0,0,${0.04 * strength})`;
}

function Chevron({ open }: { open: boolean }): JSX.Element {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 12 12"
      aria-hidden="true"
      style={{ flex: 'none', transform: open ? 'rotate(90deg)' : 'none' }}
    >
      <path d="M4 2 L8 6 L4 10" fill="none" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

function ChatIcon(): JSX.Element {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" style={{ flex: 'none' }}>
      <path
        d="M4 4h16a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H8l-4 4V5a1 1 0 0 1 1-1z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Row(props: {
  d: DiagnosisSummary;
  selected: boolean;
  onSelect?: (d: DiagnosisSummary) => void;
  disableNavigation: boolean;
  onRerun?: (d: DiagnosisSummary) => Promise<void>;
  touch: boolean;
  narrow: boolean;
}): JSX.Element {
  const { d, selected, onSelect, disableNavigation, onRerun, touch, narrow } = props;
  const theme = useTheme();
  const colours = useSeverityColours();
  const tintOf = useTint();
  const sev = severityGroup(d.severity);
  const t = formatTime(d.createdAt);
  const clickable = !!onSelect;
  const text = d.likelyCause || d.alertName || d.id;
  // An analysed row is the usual case, and the header counts it. Other states stay visible.
  const showStatus = !(narrow && d.status === 'done');
  return (
    <Box
      data-incident-row={d.id}
      data-severity-group={sev}
      aria-selected={onSelect ? selected : undefined}
      onClick={() => onSelect?.(d)}
      sx={{
        display: 'grid',
        gridTemplateColumns: '20px minmax(0, 1fr) auto',
        columnGap: 1.25,
        alignItems: 'center',
        minHeight: touch ? 52 : 40,
        flex: 'none',
        pl: 2.5,
        pr: 1.5,
        py: 0.5,
        borderRadius: 1,
        bgcolor: tintOf(sev, 0.7),
        cursor: clickable ? 'pointer' : 'default',
        outline: selected ? `2px solid ${theme.palette.text.primary}` : 'none',
        outlineOffset: -2,
      }}
    >
      <SeverityMark severity={sev} size={sev === 'critical' ? 16 : 14} />
      <Box
        title={text}
        sx={{
          fontSize: 14,
          lineHeight: 1.3,
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          color: sev === 'critical' ? 'text.primary' : 'text.secondary',
        }}
      >
        {disableNavigation ? (
          text
        ) : (
          <Link
            component={RouterLink}
            to={diagnosisUrl(d.id)}
            color="inherit"
            onClick={e => e.stopPropagation()}
          >
            {text}
          </Link>
        )}
      </Box>
      <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 0.25 }}>
        <Box
          title={t.full}
          sx={{ fontSize: 14, fontVariantNumeric: 'tabular-nums', lineHeight: 1.2 }}
        >
          {t.time}
        </Box>
        {showStatus && (
          <Box
            data-status={d.status}
            sx={{
              fontSize: 12,
              color: d.status === 'failed' ? colours.critical : 'text.secondary',
            }}
          >
            {STATUS_WORD[d.status]}
          </Box>
        )}
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

function GroupHeader(props: {
  group: IncidentGroup;
  open: boolean;
  toggle: () => void;
  touch: boolean;
  hasSelected: boolean;
  /** True when the chat is about this group. */
  selected: boolean;
  /** Selects the group for the chat. Absent without a chat widget: the header has no button then. */
  onSelectGroup?: () => void;
}): JSX.Element {
  const { group, open, toggle, touch, hasSelected, selected, onSelectGroup } = props;
  const theme = useTheme();
  const colours = useSeverityColours();
  const tintOf = useTint();
  const mix = statusMixText(group.byStatus);
  return (
    <Box
      data-incident-group={group.name}
      data-severity-group={group.worst}
      data-open={open ? '' : undefined}
      role="button"
      tabIndex={0}
      aria-expanded={open}
      aria-label={`${group.name}, ${group.rows.length} ${
        group.rows.length === 1 ? 'incident' : 'incidents'
      }, worst severity ${SEVERITY_WORD[group.worst].toLowerCase()}, ${mix}`}
      onClick={toggle}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          toggle();
        }
      }}
      sx={{
        display: 'grid',
        gridTemplateColumns: onSelectGroup
          ? '14px 20px minmax(0, 1fr) auto auto'
          : '14px 20px minmax(0, 1fr) auto',
        columnGap: 1,
        alignItems: 'center',
        minHeight: touch ? 56 : 48,
        flex: 'none',
        px: 1.5,
        py: 0.75,
        borderRadius: 1,
        bgcolor: tintOf(group.worst, 1),
        cursor: 'pointer',
        outline: selected || hasSelected ? `2px solid ${theme.palette.text.primary}` : 'none',
        outlineOffset: -2,
        '&:focus-visible': { outline: '2px solid', outlineColor: theme.palette.primary.main },
      }}
    >
      <Chevron open={open} />
      <SeverityMark severity={group.worst} size={group.worst === 'critical' ? 18 : 16} />
      <Box sx={{ minWidth: 0 }}>
        <Box
          title={group.name}
          sx={{
            fontSize: 16,
            lineHeight: 1.2,
            fontWeight: 600,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {group.name}
        </Box>
        <Box
          data-group-mix
          title={mix}
          sx={{
            mt: 0.25,
            fontSize: 12,
            lineHeight: 1.3,
            color: group.byStatus.failed > 0 ? colours.critical : 'text.secondary',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {mix}
        </Box>
      </Box>
      <Box
        data-group-count
        title={`${group.rows.length} ${group.rows.length === 1 ? 'incident' : 'incidents'}`}
        sx={{ fontSize: 18, fontVariantNumeric: 'tabular-nums', lineHeight: 1, fontWeight: 600 }}
      >
        {group.rows.length}
      </Box>
      {onSelectGroup && (
        <Box
          component="button"
          type="button"
          data-group-chat={group.name}
          aria-pressed={selected}
          aria-label={`${selected ? 'Stop chatting about' : 'Chat about'} the group ${group.name}`}
          title={selected ? 'Stop chatting about this group' : 'Chat about this group'}
          // The header opens and closes the group. The button only selects it.
          onClick={e => {
            e.stopPropagation();
            onSelectGroup();
          }}
          onKeyDown={e => e.stopPropagation()}
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 0.5,
            minWidth: touch ? 44 : 32,
            height: touch ? 44 : 32,
            p: 0.5,
            borderRadius: 1,
            cursor: 'pointer',
            font: 'inherit',
            color: selected ? theme.palette.background.paper : 'inherit',
            bgcolor: selected ? theme.palette.text.primary : 'transparent',
            border: `1px solid ${selected ? theme.palette.text.primary : theme.palette.divider}`,
            '&:focus-visible': { outline: '2px solid', outlineColor: theme.palette.primary.main },
          }}
        >
          <ChatIcon />
        </Box>
      )}
    </Box>
  );
}

export function IncidentRows(props: {
  rows: DiagnosisSummary[];
  selectedId?: string | null;
  onSelect?: (d: DiagnosisSummary) => void;
  /** The alert name of the group that the chat is about, if any. */
  selectedGroup?: string | null;
  /** Selects (or, for the selected group, clears) a group for the chat. */
  onSelectGroup?: (g: IncidentGroup) => void;
  touch?: boolean;
  disableNavigation?: boolean;
  onRerun?: (d: DiagnosisSummary) => Promise<void>;
}): JSX.Element {
  const groups = React.useMemo(() => groupByAlert(props.rows), [props.rows]);
  // Every group is closed at first. The names of the open groups stay while the rows refresh.
  const [open, setOpen] = React.useState<ReadonlySet<string>>(() => new Set());
  const toggle = React.useCallback((name: string) => {
    setOpen(prev => {
      const next = new Set(prev);
      if (!next.delete(name)) next.add(name);
      return next;
    });
  }, []);
  const { ref, width } = useElementWidth<HTMLDivElement>();
  const narrow = width !== null && width < NARROW_BELOW;
  return (
    <Box
      ref={ref}
      data-incident-rows
      data-narrow={narrow ? '' : undefined}
      // The bottom space keeps the last card, with its Run again button, clear of the fade.
      sx={{ display: 'flex', flexDirection: 'column', gap: 0.75, pb: 1.5 }}
    >
      {groups.map(g => {
        const isOpen = open.has(g.name);
        return (
          <React.Fragment key={g.name}>
            <GroupHeader
              group={g}
              open={isOpen}
              toggle={() => toggle(g.name)}
              touch={!!props.touch}
              hasSelected={!isOpen && g.rows.some(d => d.id === props.selectedId)}
              selected={props.selectedGroup === g.name}
              onSelectGroup={props.onSelectGroup ? () => props.onSelectGroup!(g) : undefined}
            />
            {isOpen &&
              g.rows.map(d => (
                <Row
                  key={d.id}
                  d={d}
                  selected={props.selectedId === d.id}
                  onSelect={props.onSelect}
                  disableNavigation={!!props.disableNavigation}
                  onRerun={props.onRerun}
                  touch={!!props.touch}
                  narrow={narrow}
                />
              ))}
          </React.Fragment>
        );
      })}
    </Box>
  );
}
