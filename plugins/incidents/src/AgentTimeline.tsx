import { Icon } from '@iconify/react';
import Box from '@mui/material/Box';
import ButtonBase from '@mui/material/ButtonBase';
import CircularProgress from '@mui/material/CircularProgress';
import Collapse from '@mui/material/Collapse';
import Typography from '@mui/material/Typography';
import React from 'react';
import { elapsed, STEP_COLOUR, StepStatus, TimelineEntry, TimelineKind } from './launch-model';

const STATUS_ICON: Record<StepStatus, string> = {
  running: 'mdi:progress-clock',
  done: 'mdi:check-circle',
  failed: 'mdi:close-circle',
  waiting: 'mdi:timer-sand',
};

const STATUS_LABEL: Record<StepStatus, string> = {
  running: 'Running',
  done: 'Done',
  failed: 'Failed',
  waiting: 'Waiting',
};

const KIND_ICON: Record<TimelineKind, string> = {
  run: 'mdi:play-circle-outline',
  message: 'mdi:message-text-outline',
  tool: 'mdi:console-line',
  file_change: 'mdi:file-document-edit-outline',
  other: 'mdi:dots-horizontal-circle-outline',
};

const PALETTE: Record<string, string> = {
  default: 'text.secondary',
  info: 'info.main',
  success: 'success.main',
  error: 'error.main',
  warning: 'warning.main',
};

/** A step status mark: a spinner while running, else a coloured icon with an accessible name. */
export function StepMark({ status }: { status: StepStatus }) {
  if (status === 'running') return <CircularProgress size={14} aria-label={STATUS_LABEL.running} />;
  return (
    <Box
      role="img"
      aria-label={STATUS_LABEL[status]}
      sx={{ display: 'flex', color: PALETTE[STEP_COLOUR[status]] }}
    >
      <Icon icon={STATUS_ICON[status]} width={16} height={16} />
    </Box>
  );
}

const preview = (text: string | undefined): string => {
  const line = (text ?? '').split('\n').find(l => l.trim()) ?? '';
  return line.length > 90 ? `${line.slice(0, 90)}...` : line;
};

/** The time a step took, or the time it has run so far. */
export function stepTime(e: TimelineEntry, now: number): string {
  return elapsed(e.startedAt, e.status === 'running' ? undefined : e.finishedAt, now);
}

/**
 * An expandable card for a tool call, a file change or a message. The header is a button
 * (aria-expanded) with the title, a one-line preview, the status and the time. The body
 * shows the full detail in a monospace block. A card with no detail is not expandable.
 */
export function ToolCard({ entry, now }: { entry: TimelineEntry; now: number }) {
  const [open, setOpen] = React.useState(false);
  const bodyId = React.useId();
  const expandable = !!entry.detail;
  const time = stepTime(entry, now);
  const head = (
    <>
      <Icon icon={KIND_ICON[entry.kind]} width={18} height={18} aria-hidden />
      <Typography variant="body2" component="span" sx={{ fontWeight: 600, whiteSpace: 'nowrap' }}>
        {entry.title}
      </Typography>
      {entry.detail && !open && (
        <Typography
          variant="body2"
          component="span"
          noWrap
          sx={{ color: 'text.secondary', minWidth: 0, flex: 1, fontFamily: 'monospace' }}
        >
          {preview(entry.detail)}
        </Typography>
      )}
      <Box sx={{ ml: 'auto', display: 'flex', alignItems: 'center', gap: 1, flexShrink: 0 }}>
        {time && (
          <Typography variant="caption" component="time" color="text.secondary">
            {time}
          </Typography>
        )}
        <StepMark status={entry.status} />
      </Box>
    </>
  );
  return (
    <Box
      data-kind={entry.kind}
      sx={theme => ({
        border: `1px solid ${theme.palette.divider}`,
        borderRadius: 1,
        overflow: 'hidden',
        ...(entry.status === 'failed' ? { borderColor: theme.palette.error.main } : {}),
      })}
    >
      {expandable ? (
        <ButtonBase
          onClick={() => setOpen(o => !o)}
          aria-expanded={open}
          aria-controls={bodyId}
          sx={{ display: 'flex', width: '100%', gap: 1, px: 1.25, py: 0.75, textAlign: 'left' }}
        >
          {head}
        </ButtonBase>
      ) : (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1.25, py: 0.75 }}>{head}</Box>
      )}
      {expandable && (
        <Collapse in={open} unmountOnExit>
          <Box
            id={bodyId}
            component="pre"
            sx={theme => ({
              m: 0,
              px: 1.5,
              py: 1,
              maxHeight: 320,
              overflow: 'auto',
              fontFamily: 'monospace',
              fontSize: '0.85em',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              borderTop: `1px solid ${theme.palette.divider}`,
              backgroundColor: theme.palette.action.hover,
            })}
          >
            {entry.detail}
          </Box>
        </Collapse>
      )}
    </Box>
  );
}

interface Group {
  run?: TimelineEntry;
  steps: TimelineEntry[];
}

/** Splits the flat timeline into runs. Entries before the first run form a group without a run. */
export function groupByRun(timeline: TimelineEntry[]): Group[] {
  const groups: Group[] = [];
  for (const e of timeline) {
    if (e.kind === 'run') groups.push({ run: e, steps: [] });
    else {
      if (groups.length === 0) groups.push({ steps: [] });
      groups[groups.length - 1].steps.push(e);
    }
  }
  return groups;
}

/**
 * A vertical timeline of the agent's runs and steps. Each run is a header with its status
 * and time. Its steps hang below it on a line. A running step shows a live timer from `now`.
 */
export function AgentTimeline({ timeline, now }: { timeline: TimelineEntry[]; now: number }) {
  const groups = groupByRun(timeline);
  const steps = timeline.filter(e => e.kind !== 'run').length;
  return (
    <Box
      component="section"
      aria-label="Agent run"
      sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}
    >
      <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1.5 }}>
        <Typography variant="subtitle1" component="h3" sx={{ fontWeight: 600 }}>
          Agent run
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {groups.filter(g => g.run).length}{' '}
          {groups.filter(g => g.run).length === 1 ? 'run' : 'runs'}
          {', '}
          {steps} {steps === 1 ? 'step' : 'steps'}
        </Typography>
      </Box>
      {timeline.length === 0 && (
        <Typography variant="body2" color="text.secondary">
          The agent has not reported a step yet.
        </Typography>
      )}
      {groups.map((g, i) => (
        <Box key={g.run?.id ?? `start-${i}`} component="ol" sx={{ listStyle: 'none', m: 0, p: 0 }}>
          {g.run && (
            <Box
              component="li"
              data-kind="run"
              sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.75 }}
            >
              <StepMark status={g.run.status} />
              <Typography variant="body2" sx={{ fontWeight: 600 }}>
                {g.run.title}
              </Typography>
              {g.run.detail && (
                <Typography variant="caption" color="text.secondary">
                  {g.run.detail}
                </Typography>
              )}
              <Typography
                variant="caption"
                component="time"
                color="text.secondary"
                sx={{ ml: 'auto' }}
              >
                {stepTime(g.run, now)}
              </Typography>
            </Box>
          )}
          {g.steps.length > 0 && (
            <Box
              component="li"
              sx={theme => ({
                ml: 1,
                pl: 2,
                borderLeft: `2px solid ${theme.palette.divider}`,
                display: 'flex',
                flexDirection: 'column',
                gap: 0.75,
              })}
            >
              {g.steps.map(e => (
                <ToolCard key={e.id} entry={e} now={now} />
              ))}
            </Box>
          )}
        </Box>
      ))}
    </Box>
  );
}
