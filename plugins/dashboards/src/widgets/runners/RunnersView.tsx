/*
 * Draws the runner model (see `join.ts`): fixed stat tiles on top, one ring for each pool (use,
 * queued and free), then one scroll area with the list. With the `runs` panel the list is a tree:
 * a repository, then its branch or pull request, then the workflow, then the job. The steps of a
 * job are one more level that opens under the job. Each row shows the running and queued job
 * counts and the longest time. A job row shows its state, node, waited time and running time.
 * Without the `runs` panel the list is the queue rows.
 * Every row is drawn: nothing folds into a "+N more" line.
 *
 * A click, or Enter or Space, opens or folds a row in place. No row is a link: nothing in the
 * list navigates, opens a tab or changes the dashboard tab. Repos are folded at first. The open
 * rows are in the page URL, in the param `w.<widget id>`, written with history replace. The URL
 * holds the node keys that differ from the default, so a reload, a refresh of the data and the
 * kiosk mode keep the view. In edit mode a click changes the view only, not the URL.
 *
 * Two options change the look, so one tab can use the widget as a compact strip and another as a
 * full list: `view` (`full`, `summary` for the tiles and rings only, `list` for the tree only) and
 * `expand` (`all` opens every row at first; the default folds the repos).
 * A repo row shows its icon when the icon map has one (see `icons.ts`).
 */
import { Icon } from '@iconify/react';
import Box from '@mui/material/Box';
import FormControlLabel from '@mui/material/FormControlLabel';
import Switch from '@mui/material/Switch';
import Tooltip from '@mui/material/Tooltip';
import React from 'react';
import { ScrollArea } from '../../components/ScrollArea';
import { useWidgetUrlState } from '../../widgetUrlState';
import { WidgetFooter } from '../footer';
import type { JobPhase, PanelStatus, PanelStep, Stat, StepState } from '../panels/model';
import { StatusMark } from '../panels/StatusMark';
import { useTokens } from '../panels/tokens';
import { useElementSize } from '../promql/useElementSize';
import { GroupIcon } from './GroupIcon';
import { type IconMap, repoIconFor, useIconMap } from './icons';
import {
  type Counted,
  formatNodeKeys,
  formatWait,
  groupTree,
  type JobEntry,
  jobNodeOf,
  jobRunSecondsOf,
  jobWaitSecondsOf,
  NO_BRANCH,
  parseNodeKeys,
  progressOf,
  type QueueRow,
  type RepoNode,
  type RunnerModel,
  type RunnerPool,
  runSuffixOf,
  STEP_GAP,
  STEP_GROUP_ORDER,
  STEP_MIN_SEGMENT,
  stepBarLayout,
  treeKeys,
  type TreeOptions,
} from './join';

/** What the widget draws: the tiles, the rings and the list, or only one part. */
export type RunnersViewMode = 'full' | 'summary' | 'list';
export const VIEW_MODES: ReadonlyArray<RunnersViewMode> = ['full', 'summary', 'list'];

/** `all` opens every row at first. Anything else keeps the default (repos folded). */
export type RunnersExpand = 'default' | 'all';

/** Reads the `view` option of a saved config. A missing or wrong value gives `full`. */
export function viewOf(raw: unknown): RunnersViewMode {
  return raw === 'summary' || raw === 'list' ? raw : 'full';
}

/** Reads the `expand` option of a saved config. A missing or wrong value gives `default`. */
export function expandOf(raw: unknown): RunnersExpand {
  return raw === 'all' ? 'all' : 'default';
}

const RING_SIZE = 46;
const RING_STROKE = 6;
const HATCH_STEP = 3.4;
let hatchCounter = 0;

const EMPTY = 'No queued jobs';
export const HOSTED_WORD = 'GitHub-hosted';

/** The words for a step state, for the tooltip and the screen reader. */
export const STEP_WORD: Record<StepState, string> = {
  done: 'Done',
  running: 'Running',
  failed: 'Failed',
  skipped: 'Skipped',
  pending: 'Pending',
};

/** The colours of the ring: running, queued and free. They stay the same in every pool. */
export function useRingColours(): { running: string; queued: string; hatch: string } {
  const tk = useTokens();
  return { running: tk.info, queued: tk.status.warn, hatch: tk.fg2 };
}

/** The arcs of a pool ring as fractions of the circle. Free is the rest of the cap. */
export function ringShares(p: Pick<RunnerPool, 'running' | 'queued' | 'cap'>): {
  running: number;
  queued: number;
  free: number;
} {
  const total = Math.max(p.cap, p.running + p.queued);
  if (total <= 0) return { running: 0, queued: 0, free: 1 };
  const running = Math.min(1, p.running / total);
  const queued = Math.min(1 - running, p.queued / total);
  return { running, queued, free: Math.max(0, 1 - running - queued) };
}

function PoolRing(props: { pool: RunnerPool; hatchId: string }): JSX.Element {
  const { pool, hatchId } = props;
  const tk = useTokens();
  const c = useRingColours();
  const r = (RING_SIZE - RING_STROKE) / 2;
  const len = 2 * Math.PI * r;
  const shares = ringShares(pool);
  const arc = (from: number, share: number, stroke: string, extra?: object) =>
    share > 0 ? (
      <circle
        cx={RING_SIZE / 2}
        cy={RING_SIZE / 2}
        r={r}
        fill="none"
        stroke={stroke}
        strokeWidth={RING_STROKE}
        strokeDasharray={`${share * len} ${len}`}
        strokeDashoffset={-from * len}
        transform={`rotate(-90 ${RING_SIZE / 2} ${RING_SIZE / 2})`}
        {...extra}
      />
    ) : null;
  const value = pool.cap > 0 ? `${pool.running}/${pool.cap}` : String(pool.running);
  const title = `${pool.name}: ${pool.running} running, ${pool.queued} queued, ${pool.free} free`;
  return (
    <Tooltip title={title} arrow disableInteractive>
      <Box
        data-pool={pool.name}
        role="img"
        aria-label={title}
        sx={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          width: 88,
          flex: 'none',
          minWidth: 0,
        }}
      >
        <Box sx={{ position: 'relative', width: RING_SIZE, height: RING_SIZE }}>
          <svg width={RING_SIZE} height={RING_SIZE} viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}>
            <circle
              cx={RING_SIZE / 2}
              cy={RING_SIZE / 2}
              r={r}
              fill="none"
              stroke={tk.track}
              strokeWidth={RING_STROKE}
              opacity={0.5}
            />
            {arc(shares.running + shares.queued, shares.free, `url(#${hatchId})`, {
              'data-ring': 'free',
            })}
            {arc(0, shares.running, c.running, { 'data-ring': 'running' })}
            {arc(shares.running, shares.queued, c.queued, { 'data-ring': 'queued' })}
          </svg>
          <Box
            sx={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: tk.fg2,
            }}
          >
            <Icon icon="mdi:server" width={17} height={17} />
          </Box>
        </Box>
        <Box
          data-pool-name
          sx={{
            mt: '2px',
            fontSize: 11.5,
            lineHeight: 1.25,
            maxWidth: '100%',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            color: tk.fg2,
          }}
        >
          {pool.name}
        </Box>
        <Box
          data-pool-value
          sx={{
            fontSize: 12.5,
            lineHeight: 1.25,
            fontVariantNumeric: 'tabular-nums',
            whiteSpace: 'nowrap',
          }}
        >
          {value}
        </Box>
      </Box>
    </Tooltip>
  );
}

function Pools(props: { pools: RunnerPool[] }): JSX.Element {
  const tk = useTokens();
  const hatchId = React.useRef(`rp-hatch-${++hatchCounter}`).current;
  return (
    <Box
      data-pools
      sx={{
        display: 'flex',
        flexWrap: 'nowrap',
        overflowX: 'auto',
        flex: 'none',
        justifyContent: 'safe center',
      }}
    >
      <svg width={0} height={0} style={{ position: 'absolute' }} aria-hidden>
        <defs>
          <pattern
            id={hatchId}
            patternUnits="userSpaceOnUse"
            width={HATCH_STEP}
            height={HATCH_STEP}
            patternTransform="rotate(45)"
          >
            <path
              d={`M0 0H${HATCH_STEP}M0 0V${HATCH_STEP}`}
              stroke={tk.fg2}
              strokeOpacity={0.5}
              strokeWidth={0.5}
              fill="none"
            />
          </pattern>
        </defs>
      </svg>
      {props.pools.map(p => (
        <PoolRing key={p.name} pool={p} hatchId={hatchId} />
      ))}
    </Box>
  );
}

/** The fixed stat tiles. Running, queued and free carry the colour of their ring arc. */
function Tiles(props: { stats: Stat[]; small?: boolean }): JSX.Element {
  const tk = useTokens();
  const c = useRingColours();
  const mark = [c.running, c.queued, 'hatch'];
  return (
    <Box data-stats sx={{ display: 'flex', gap: '6px', flex: 'none', pt: '2px' }}>
      {props.stats.map((s, i) => (
        <Box key={s.label} data-stat sx={{ flex: '1 1 0', minWidth: 0 }}>
          <Box
            data-stat-value
            sx={{
              fontSize: props.small ? 20 : 24,
              lineHeight: 1.1,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              letterSpacing: '-0.01em',
              fontVariantNumeric: 'tabular-nums',
              whiteSpace: 'nowrap',
              color: s.value.trim() === '0' ? tk.mut : tk.fg,
            }}
          >
            {s.value}
          </Box>
          <Box
            data-stat-label
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: '5px',
              mt: '2px',
              fontSize: 11.5,
              color: tk.fg2,
              whiteSpace: 'nowrap',
            }}
          >
            {i < 3 && (
              <Box
                sx={{
                  width: 8,
                  height: 8,
                  flex: 'none',
                  borderRadius: '2px',
                  background:
                    mark[i] === 'hatch'
                      ? `repeating-linear-gradient(45deg, transparent 0 1.5px, ${tk.fg2} 1.5px 2.2px)`
                      : mark[i],
                  boxShadow: mark[i] === 'hatch' ? `inset 0 0 0 1px ${tk.line2}` : 'none',
                }}
              />
            )}
            <Box component="span" sx={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {s.label}
            </Box>
          </Box>
        </Box>
      ))}
    </Box>
  );
}

/** The colour of a step segment. Done is green, running amber, failed red, skipped grey and pending faint. */
export function useStepColours(): Record<StepState, string> {
  const tk = useTokens();
  return {
    done: tk.status.ok,
    running: tk.status.warn,
    failed: tk.status.crit,
    skipped: tk.mode === 'dark' ? 'rgba(255,255,255,0.40)' : 'rgba(0,0,0,0.38)',
    pending: tk.track,
  };
}

/**
 * The step bar. Each step has its own segment while all segments stay at least 4 px wide. With
 * more steps than that, it is one continuous strip with a block for each state, sized by the
 * step count. The running part pulses softly, and never when motion is reduced.
 */
export function StepBar(props: { steps: ReadonlyArray<PanelStep> }): JSX.Element {
  const colours = useStepColours();
  const { ref, size } = useElementSize<HTMLDivElement>();
  const layout = stepBarLayout(props.steps, size.width);
  const summary = STEP_GROUP_ORDER.map(state => ({
    state,
    count: props.steps.filter(s => s.state === state).length,
  }))
    .filter(g => g.count > 0)
    .map(g => `${g.count} ${STEP_WORD[g.state].toLowerCase()}`)
    .join(', ');
  return (
    <Box
      ref={ref}
      data-step-bar
      data-step-bar-mode={layout.mode}
      role="img"
      aria-label={`${props.steps.length} steps: ${summary}`}
      sx={{
        display: 'flex',
        gap: layout.mode === 'segments' ? `${STEP_GAP}px` : 0,
        width: '100%',
        height: 6,
        minWidth: 0,
        overflow: 'hidden',
        borderRadius: '3px',
        '@keyframes stepPulse': { '0%, 100%': { opacity: 1 }, '50%': { opacity: 0.55 } },
        '& [data-step-state="running"]': {
          animation: 'stepPulse 2.4s ease-in-out infinite',
          '@media (prefers-reduced-motion: reduce)': { animation: 'none' },
        },
      }}
    >
      {layout.mode === 'segments'
        ? props.steps.map((s, i) => (
            <Tooltip
              key={`${s.name}-${i}`}
              title={`${s.name}: ${STEP_WORD[s.state]}`}
              disableInteractive
            >
              <Box
                data-step-state={s.state}
                sx={{
                  flex: '1 1 0',
                  minWidth: STEP_MIN_SEGMENT,
                  borderRadius: '2px',
                  bgcolor: colours[s.state],
                }}
              />
            </Tooltip>
          ))
        : layout.groups.map(g => (
            <Tooltip
              key={g.state}
              title={`${g.count} ${STEP_WORD[g.state].toLowerCase()}`}
              disableInteractive
            >
              <Box
                data-step-state={g.state}
                data-step-count={g.count}
                sx={{
                  flex: `${g.count} 1 0`,
                  minWidth: 2,
                  bgcolor: colours[g.state],
                }}
              />
            </Tooltip>
          ))}
    </Box>
  );
}

/**
 * The step bar on its own line at the full width, then "step N of M" and the current step name on
 * the next line. The two never share a line, so they cannot overlap at any step count.
 */
function Progress(props: { steps: ReadonlyArray<PanelStep>; waiting?: boolean }): JSX.Element {
  const tk = useTokens();
  const p = progressOf(props.steps);
  return (
    <Box data-progress sx={{ display: 'flex', flexDirection: 'column', gap: '3px', minWidth: 0 }}>
      {p ? (
        <>
          <StepBar steps={props.steps} />
          <Box
            data-progress-text
            sx={{
              fontSize: 11.5,
              color: tk.fg2,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              minWidth: 0,
            }}
          >
            step {p.n} of {p.total} · {p.name}
          </Box>
        </>
      ) : (
        <Box data-progress-text sx={{ fontSize: 11.5, color: tk.fg2 }}>
          {props.waiting ? 'Waiting for a runner' : 'No steps yet'}
        </Box>
      )}
    </Box>
  );
}

function Chevron(props: { open: boolean; show: boolean }): JSX.Element {
  return (
    <Box
      sx={{
        width: 16,
        height: 16,
        flex: 'none',
        display: 'inline-flex',
        transform: props.open ? 'none' : 'rotate(-90deg)',
        visibility: props.show ? 'visible' : 'hidden',
      }}
    >
      <Icon icon="mdi:chevron-down" width={16} height={16} />
    </Box>
  );
}

const rowSx = (tk: ReturnType<typeof useTokens>, depth: number) => ({
  display: 'flex',
  flexDirection: 'column' as const,
  gap: '3px',
  minWidth: 0,
  py: '5px',
  pl: `${depth * 18}px`,
  boxShadow: `inset 0 -1px 0 ${tk.line}`,
});

const TIME_SX = {
  flex: 'none',
  fontSize: 13,
  fontVariantNumeric: 'tabular-nums',
  whiteSpace: 'nowrap',
} as const;

function StepList(props: { steps: ReadonlyArray<PanelStep>; depth: number }): JSX.Element {
  // `depth` is the indent level of the job row. The steps sit one chevron further in.
  const tk = useTokens();
  const colours = useStepColours();
  return (
    <Box data-step-list sx={{ pl: `${props.depth * 18 + 16}px`, py: '4px' }}>
      {props.steps.map((s, i) => (
        <Box
          key={`${s.name}-${i}`}
          data-step={s.state}
          sx={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: 12, minWidth: 0 }}
        >
          <Box
            sx={{
              width: 8,
              height: 8,
              borderRadius: '2px',
              flex: 'none',
              bgcolor: colours[s.state],
            }}
          />
          <Box
            sx={{
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              color: s.state === 'pending' || s.state === 'skipped' ? tk.fg2 : tk.fg,
            }}
          >
            {s.name}
          </Box>
          <Box sx={{ ml: 'auto', flex: 'none', color: tk.fg2 }}>{STEP_WORD[s.state]}</Box>
        </Box>
      ))}
    </Box>
  );
}

/** "2 running, 1 queued". A count of 0 is left out. Both 0 gives "idle". */
export function countsText(g: { running: number; queued: number }): string {
  const parts = [
    g.running > 0 ? `${g.running} running` : '',
    g.queued > 0 ? `${g.queued} queued` : '',
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : 'idle';
}

/** Fold or open a row from the keyboard: Enter and Space. */
const keyToggle =
  (toggle: () => void) =>
  (e: React.KeyboardEvent): void => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggle();
    }
  };

/** The props that make a row open and close in place when it is clicked. It never navigates. */
function toggleProps(expandable: boolean, open: boolean, toggle: () => void, label: string) {
  return expandable
    ? {
        role: 'button' as const,
        tabIndex: 0,
        'aria-expanded': open,
        'aria-label': `${open ? 'Fold' : 'Expand'} ${label}`,
        onClick: toggle,
        onKeyDown: keyToggle(toggle),
      }
    : {};
}

/** The running and queued counts of a group row, then its longest time. */
function GroupCounts(props: Counted): JSX.Element {
  const tk = useTokens();
  const c = useRingColours();
  return (
    <>
      <Box
        data-group-counts
        sx={{
          ml: 'auto',
          flex: 'none',
          display: 'flex',
          gap: '6px',
          fontSize: 11.5,
          fontVariantNumeric: 'tabular-nums',
          whiteSpace: 'nowrap',
          color: tk.fg2,
        }}
      >
        {props.running > 0 && (
          <Box component="span" data-group-running sx={{ color: c.running }}>
            {props.running} running
          </Box>
        )}
        {props.queued > 0 && (
          <Box component="span" data-group-queued sx={{ color: c.queued }}>
            {props.queued} queued
          </Box>
        )}
      </Box>
      <Box
        data-time
        title="Longest time in this group"
        sx={{ ...TIME_SX, minWidth: 52, ml: '8px', textAlign: 'right' }}
      >
        {formatWait(props.longest)}
      </Box>
    </>
  );
}

/** The chip on a job, a group or a repo that runs on GitHub-hosted runners only. */
function HostedChip(): JSX.Element {
  const tk = useTokens();
  return (
    <Box
      component="span"
      data-hosted-chip
      title="Runs on GitHub-hosted runners, not on the runners of this source"
      sx={{
        flex: 'none',
        fontSize: 10.5,
        lineHeight: 1.4,
        px: '6px',
        borderRadius: '8px',
        fontWeight: 400,
        color: tk.fg2,
        boxShadow: `inset 0 0 0 1px ${tk.line2}`,
        whiteSpace: 'nowrap',
      }}
    >
      {HOSTED_WORD}
    </Box>
  );
}

/** "last run 1h 20m ago", with the full local date and time in the title. */
function LastRun(props: { at?: string; conclusion?: string }): JSX.Element {
  const tk = useTokens();
  const t = props.at ? Date.parse(props.at) : NaN;
  const known = Number.isFinite(t);
  const text = known ? `last run ${formatWait((Date.now() - t) / 1000)} ago` : 'no recent run';
  const title = known
    ? `${new Date(t).toLocaleString()}${props.conclusion ? `, ${props.conclusion}` : ''}`
    : 'The source has no recent run for this repository';
  return (
    <Box
      data-last-run
      title={title}
      sx={{
        ml: 'auto',
        flex: 'none',
        fontSize: 11.5,
        fontVariantNumeric: 'tabular-nums',
        whiteSpace: 'nowrap',
        color: tk.mut,
      }}
    >
      {text}
    </Box>
  );
}

type GroupKind = 'repo' | 'ref' | 'workflow';

/**
 * The row of a repo, a branch or pull request, or a workflow: chevron, name, the counts and the
 * longest time. A click or Enter or Space opens or folds it in place. It is never a link.
 */
function GroupRow(props: {
  kind: GroupKind;
  nodeKey: string;
  group: Counted;
  label: React.ReactNode;
  /** The plain text of the label, for the screen reader. */
  name: string;
  depth: number;
  open: boolean;
  expandable: boolean;
  toggle: () => void;
  /** The icon address, or undefined. Used only when `slot` is true. */
  icon?: string;
  /** Draw the icon slot, even when this row has no icon. */
  slot?: boolean;
  /** Show the chip: every job of this row is GitHub-hosted. */
  hosted?: boolean;
  /** Show the last run time instead of the counts: the row has no running or queued job. */
  lastRun?: { at?: string; conclusion?: string };
}): JSX.Element {
  const { kind, group, depth, open, expandable, toggle, icon, slot = false } = props;
  const tk = useTokens();
  return (
    <Box
      data-group={kind}
      data-group-key={props.nodeKey}
      data-open={open ? '' : undefined}
      {...toggleProps(expandable, open, toggle, props.name)}
      sx={{
        ...rowSx(tk, depth),
        flexDirection: 'row',
        alignItems: 'center',
        gap: '4px',
        cursor: expandable ? 'pointer' : 'default',
      }}
    >
      <Chevron open={open} show={expandable} />
      {slot && <GroupIcon src={icon} name={props.name} />}
      <Box
        data-group-name
        sx={{
          fontSize: kind === 'repo' ? 13.5 : 13,
          fontWeight: kind === 'workflow' ? 500 : 600,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          minWidth: 0,
          display: 'flex',
          gap: '6px',
          alignItems: 'baseline',
        }}
      >
        {props.label}
      </Box>
      {props.hosted && <HostedChip />}
      {props.lastRun ? (
        <LastRun at={props.lastRun.at} conclusion={props.lastRun.conclusion} />
      ) : (
        <GroupCounts running={group.running} queued={group.queued} longest={group.longest} />
      )}
    </Box>
  );
}

/** The mark of a job state: a shape and a word. Running is a circle, assigned a ring, queued a triangle. */
const JOB_MARK: Record<JobPhase, PanelStatus> = {
  running: 'ok',
  assigned: 'unknown',
  queued: 'warn',
};

/** One job: its state, node, waited time and running time. A click opens its steps. */
function JobRow(props: {
  entry: JobEntry;
  /** The suffix that tells the runs of one workflow apart. Empty when the workflow has one run. */
  suffix: string;
  depth: number;
  open: boolean;
  toggle: () => void;
}): JSX.Element {
  const { entry, suffix, depth, open, toggle } = props;
  const { job } = entry;
  const tk = useTokens();
  const hasSteps = job.steps.length > 0;
  const node = jobNodeOf(job);
  const waited = jobWaitSecondsOf(job);
  const ran = jobRunSecondsOf(job);
  const timeCell = (word: string, value: number | undefined, attr: Record<string, string>) => (
    <Box
      component="span"
      title={word === 'wait' ? 'Waited for a runner' : 'Running time'}
      sx={{ ...TIME_SX, color: tk.fg2, fontSize: 12, minWidth: 40, textAlign: 'right' }}
    >
      <Box component="span" sx={{ fontSize: 10.5, mr: '3px', color: tk.mut }}>
        {word}
      </Box>
      <Box component="span" {...attr} sx={{ color: tk.fg }}>
        {value === undefined ? '-' : formatWait(value)}
      </Box>
    </Box>
  );
  return (
    <>
      <Box
        data-job={job.id}
        data-job-key={entry.key}
        data-open={open ? '' : undefined}
        {...toggleProps(hasSteps, open, toggle, job.name)}
        sx={{ ...rowSx(tk, depth), cursor: hasSteps ? 'pointer' : 'default' }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: '4px', minWidth: 0 }}>
          <Chevron open={open} show={hasSteps} />
          <StatusMark status={JOB_MARK[job.phase]} size={11} />
          <Box
            component="span"
            data-job-state={job.phase}
            sx={{ fontSize: 11, color: tk.fg2, flex: 'none' }}
          >
            {job.phase}
          </Box>
          <Box
            data-job-name
            sx={{
              fontSize: 13,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              minWidth: 0,
            }}
          >
            {job.name}
            {suffix && (
              <Box
                component="span"
                data-run-suffix
                title={`Run ${entry.run.id}`}
                sx={{ ml: '6px', fontSize: 11, color: tk.fg2 }}
              >
                {suffix}
              </Box>
            )}
          </Box>
          {entry.hosted && <HostedChip />}
          <Box
            data-job-node
            data-node-reported={node.reported ? 'true' : 'false'}
            title={node.reported ? 'Node' : 'Node not reported, pool shown'}
            sx={{
              ml: 'auto',
              flex: '0 1 auto',
              minWidth: 0,
              maxWidth: 110,
              fontSize: 12,
              color: node.reported ? tk.fg : tk.mut,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {node.text || '-'}
          </Box>
          {timeCell('wait', waited, { 'data-job-waited': '' })}
          {timeCell('run', ran, { 'data-job-running': '' })}
        </Box>
        {hasSteps && (
          <Box sx={{ pl: '20px' }}>
            <Progress steps={job.steps} waiting={job.phase === 'queued'} />
          </Box>
        )}
      </Box>
      {open && hasSteps && <StepList steps={job.steps} depth={depth} />}
    </>
  );
}

/** The label of a ref row: `PR #12` with the branch after it, the branch name, or "No branch". */
function RefLabel(props: { name: string; pr?: number }): JSX.Element {
  const tk = useTokens();
  const { name, pr } = props;
  if (pr !== undefined) {
    return (
      <>
        <span data-ref-pr>{`PR #${pr}`}</span>
        {name && (
          <Box component="span" data-ref-branch sx={{ color: tk.fg2, fontWeight: 400 }}>
            {name}
          </Box>
        )}
      </>
    );
  }
  if (name === '') {
    return (
      <Box component="span" data-ref-none sx={{ color: tk.mut, fontStyle: 'italic' }}>
        {NO_BRANCH}
      </Box>
    );
  }
  return <span>{name}</span>;
}

/**
 * The tree: repo, then branch or pull request, then workflow, then job (and the steps of a job).
 * Every row opens and folds in place. `toggled` holds the node keys that differ from the default:
 * with no `expandAll` they are the open rows, with `expandAll` they are the rows that the user
 * folded. No row is a link.
 */
function RunTree(props: {
  tree: RepoNode[];
  toggled: ReadonlySet<string>;
  expandAll: boolean;
  toggle: (key: string) => void;
  icons: IconMap;
}): JSX.Element {
  const { tree, toggled, expandAll, toggle, icons } = props;
  // One slot for every repo row as soon as one has an icon, so the names stay aligned.
  const slot = React.useMemo(
    () => tree.some(r => repoIconFor(r.org, r.short, icons) !== undefined),
    [tree, icons]
  );
  const isOpen = (key: string): boolean => (expandAll ? !toggled.has(key) : toggled.has(key));
  return (
    <>
      {tree.map(repo => {
        const repoOpen = isOpen(repo.key);
        return (
          <React.Fragment key={repo.key}>
            <GroupRow
              kind="repo"
              nodeKey={repo.key}
              group={repo}
              label={repo.name}
              name={repo.name}
              depth={0}
              open={repoOpen && !repo.idle}
              expandable={!repo.idle}
              toggle={() => toggle(repo.key)}
              icon={repoIconFor(repo.org, repo.short, icons)}
              slot={slot}
              hosted={repo.hosted}
              lastRun={
                repo.idle && repo.queued === 0
                  ? { at: repo.lastRunAt, conclusion: repo.lastConclusion }
                  : undefined
              }
            />
            {repoOpen &&
              !repo.idle &&
              repo.refs.map(ref => {
                const refOpen = isOpen(ref.key);
                return (
                  <React.Fragment key={ref.key}>
                    <GroupRow
                      kind="ref"
                      nodeKey={ref.key}
                      group={ref}
                      label={<RefLabel name={ref.name} pr={ref.pr} />}
                      name={
                        ref.pr !== undefined ? `PR #${ref.pr} ${ref.name}` : ref.name || NO_BRANCH
                      }
                      depth={1}
                      open={refOpen}
                      expandable
                      toggle={() => toggle(ref.key)}
                      hosted={ref.hosted}
                    />
                    {refOpen &&
                      ref.workflows.map(wf => {
                        const wfOpen = isOpen(wf.key);
                        return (
                          <React.Fragment key={wf.key}>
                            <GroupRow
                              kind="workflow"
                              nodeKey={wf.key}
                              group={wf}
                              label={wf.name}
                              name={wf.name}
                              depth={2}
                              open={wfOpen}
                              expandable={wf.jobs.length > 0}
                              toggle={() => toggle(wf.key)}
                              hosted={wf.hosted}
                            />
                            {wfOpen &&
                              wf.jobs.map(entry => (
                                <JobRow
                                  key={entry.key}
                                  entry={entry}
                                  suffix={wf.runs.length > 1 ? runSuffixOf(entry.run) : ''}
                                  depth={3}
                                  open={isOpen(entry.key)}
                                  toggle={() => toggle(entry.key)}
                                />
                              ))}
                          </React.Fragment>
                        );
                      })}
                  </React.Fragment>
                );
              })}
          </React.Fragment>
        );
      })}
    </>
  );
}

/** The queue rows of a source with no `runs` panel. They are plain rows, never links. */
function QueueRows(props: { rows: QueueRow[] }): JSX.Element {
  const tk = useTokens();
  return (
    <>
      {props.rows.map(r => (
        <Box key={r.key} data-queue-row sx={rowSx(tk, 0)}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
            <Box
              component="span"
              sx={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis' }}
            >
              {r.repo}
            </Box>
            <Box data-time sx={{ ...TIME_SX, ml: 'auto' }}>
              {r.oldest}
            </Box>
          </Box>
          <Box sx={{ fontSize: 11.5, color: tk.fg2 }}>
            {[r.pool, `${r.queued} queued`].filter(Boolean).join(' · ')}
          </Box>
        </Box>
      ))}
    </>
  );
}

/**
 * The filter "Show GitHub-hosted", kept in the page URL as `w.<instanceId>.hosted=1` (history
 * replace). In edit mode, or with no `instanceId`, a change is local to the view and the URL stays.
 */
function useHostedFilter(props: {
  instanceId?: string;
  editing: boolean;
}): [boolean, (on: boolean) => void] {
  const { instanceId, editing } = props;
  const [text, write] = useWidgetUrlState(instanceId, 'hosted');
  const localOnly = editing || !instanceId;
  const [local, setLocal] = React.useState<boolean | null>(null);
  React.useEffect(() => {
    if (!localOnly) setLocal(null);
  }, [localOnly]);
  const on = localOnly && local !== null ? local : text === '1';
  const set = React.useCallback(
    (next: boolean) => {
      if (localOnly) setLocal(next);
      else write(next ? '1' : '');
    },
    [localOnly, write]
  );
  return [on, set];
}

/** The small switch that shows or hides the GitHub-hosted jobs. */
function HostedToggle(props: { on: boolean; set: (on: boolean) => void }): JSX.Element {
  const tk = useTokens();
  return (
    <FormControlLabel
      data-hosted-toggle
      sx={{
        m: 0,
        flex: 'none',
        alignSelf: 'flex-end',
        // A small gap, so the label does not touch the thumb of the switch.
        '& .MuiFormControlLabel-label': { fontSize: 11.5, color: tk.fg2, ml: 0.75 },
      }}
      control={
        <Switch
          size="small"
          checked={props.on}
          onChange={e => props.set(e.target.checked)}
          inputProps={{ 'aria-label': `Show ${HOSTED_WORD}` }}
        />
      }
      label={`Show ${HOSTED_WORD}`}
    />
  );
}

/**
 * The open rows of the tree, kept in the page URL (`w.<instanceId>`, written with history replace)
 * so the URL alone reproduces the view. In edit mode, or with no `instanceId`, a toggle changes
 * the view only and the URL stays as it is. A key that no longer exists is dropped only when the
 * state is written, never when it is read.
 */
function useTreeState(props: {
  instanceId?: string;
  editing: boolean;
  /** The tree with every node, also the hidden ones: only keys outside it are dropped on a write. */
  tree: RepoNode[];
}): [ReadonlySet<string>, (key: string) => void] {
  const { instanceId, editing, tree } = props;
  const [text, write] = useWidgetUrlState(instanceId);
  const [local, setLocal] = React.useState<ReadonlySet<string> | null>(null);
  const localOnly = editing || !instanceId;
  React.useEffect(() => {
    // The view in edit mode is a draft. Leaving edit mode goes back to the URL.
    if (!localOnly) setLocal(null);
  }, [localOnly]);
  const fromUrl = React.useMemo(() => parseNodeKeys(text), [text]);
  const current = localOnly && local ? local : fromUrl;
  const treeRef = React.useRef(tree);
  treeRef.current = tree;
  const currentRef = React.useRef(current);
  currentRef.current = current;
  const toggle = React.useCallback(
    (key: string) => {
      const next = new Set(currentRef.current);
      if (!next.delete(key)) next.add(key);
      currentRef.current = next;
      if (localOnly) {
        setLocal(next);
        return;
      }
      write(formatNodeKeys(next, treeKeys(treeRef.current)));
    },
    [localOnly, write]
  );
  return [current, toggle];
}

export function RunnersView(props: {
  model: RunnerModel;
  editing: boolean;
  /** What to draw. Default: the tiles, the rings and the list. */
  view?: RunnersViewMode;
  /** `all` opens every row at first. */
  expand?: RunnersExpand;
  /** The id of the widget on the page: the open rows are in the URL param `w.<instanceId>`. */
  instanceId?: string;
}): JSX.Element {
  const { model, editing, view = 'full', expand = 'default', instanceId } = props;
  const tk = useTokens();
  const root = useElementSize<HTMLDivElement>();
  const icons = useIconMap();
  const [showHosted, setShowHosted] = useHostedFilter({ instanceId, editing });
  const treeOptions = React.useMemo<TreeOptions>(
    () => ({
      showHosted,
      pools: new Set(model.poolNames),
      repos: model.repos,
      queue: model.queue,
    }),
    [showHosted, model.poolNames, model.repos, model.queue]
  );
  const tree = React.useMemo(() => groupTree(model.runs, treeOptions), [model.runs, treeOptions]);
  // The switch shows when the filter hides something, and while it is on (so it can be turned off).
  const everything = React.useMemo(
    () => (showHosted ? tree : groupTree(model.runs, { ...treeOptions, showHosted: true })),
    [showHosted, tree, model.runs, treeOptions]
  );
  const hasHosted = model.tree && (showHosted || treeKeys(everything).size !== treeKeys(tree).size);

  const [toggled, toggle] = useTreeState({ instanceId, editing, tree: everything });
  const empty = model.tree ? tree.length === 0 : model.queue.length === 0;
  const showSummary = view !== 'list';
  const showList = view !== 'summary';
  const unlisted = model.tree && model.unlisted > 0;
  const summary = (
    <>
      <Box data-runners-tiles sx={{ flex: view === 'summary' ? '1 1 0' : 'none', minWidth: 0 }}>
        <Tiles stats={model.stats} small={view === 'summary'} />
      </Box>
      {model.pools.length > 0 && <Pools pools={model.pools} />}
    </>
  );
  return (
    <Box
      ref={root.ref}
      data-runners
      data-runners-view={view}
      sx={{
        display: 'flex',
        flexDirection: 'column',
        gap: 0.75,
        minWidth: 0,
        height: '100%',
        minHeight: 0,
        overflow: 'hidden',
      }}
    >
      {showSummary &&
        (view === 'summary' ? (
          // The strip: the tiles and the rings side by side, in one band.
          <Box
            data-runners-strip
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 2,
              minWidth: 0,
              flex: '1 1 auto',
              minHeight: 0,
            }}
          >
            {summary}
          </Box>
        ) : (
          summary
        ))}
      {showList && model.tree && hasHosted && <HostedToggle on={showHosted} set={setShowHosted} />}
      {showList && (
        <ScrollArea label="Running and queued runs">
          {empty ? (
            <Box data-runners-empty sx={{ py: 1, fontSize: 13, color: tk.fg2 }}>
              {EMPTY}
            </Box>
          ) : model.tree ? (
            <RunTree
              tree={tree}
              toggled={toggled}
              expandAll={expand === 'all'}
              toggle={toggle}
              icons={icons}
            />
          ) : (
            <QueueRows rows={model.queue} />
          )}
        </ScrollArea>
      )}
      {/* The list view leaves the summary to the strip above it. A note about unlisted jobs stays. */}
      {(view !== 'list' || unlisted) && (
        <WidgetFooter status={model.status}>
          {view !== 'list' && <span data-runners-summary>{model.summary}</span>}
          {unlisted && (
            <span
              data-runners-unlisted
              title="The source lists a limited number of runs. These jobs belong to runs that are not in the list. The tiles count them."
            >
              {`${view === 'list' ? '' : ', '}+${model.unlisted} ${
                model.unlisted === 1 ? 'job' : 'jobs'
              } not listed`}
            </span>
          )}
        </WidgetFooter>
      )}
    </Box>
  );
}
