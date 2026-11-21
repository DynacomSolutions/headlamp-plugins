/*
 * Draws the runner model (see `join.ts`): fixed stat tiles on top, one ring for each pool (use,
 * queued and free), then one scroll area with the list. With the `runs` panel the list is a tree:
 * a run, its jobs and their steps, collapsed by default. Without it the list is the queue rows.
 * Every row is drawn: nothing folds into a "+N more" line. A link goes only to a dashboard tab.
 */
import { Icon } from '@iconify/react';
import Box from '@mui/material/Box';
import Tooltip from '@mui/material/Tooltip';
import React from 'react';
import { ScrollArea } from '../../components/ScrollArea';
import { InternalLink, useResolveLink } from '../../links';
import { WidgetFooter } from '../footer';
import type { PanelJob, PanelRun, PanelStep, Stat, StepState } from '../panels/model';
import { useTokens } from '../panels/tokens';
import { useElementSize } from '../promql/useElementSize';
import {
  formatWait,
  progressOf,
  type QueueRow,
  type RunnerModel,
  type RunnerPool,
  stepsOfRun,
} from './join';

const RING_SIZE = 46;
const RING_STROKE = 6;
const HATCH_STEP = 3.4;
let hatchCounter = 0;

const LINK_STYLE: React.CSSProperties = { color: 'inherit', textDecoration: 'none' };
const EMPTY = 'No queued jobs';

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
function Tiles(props: { stats: Stat[] }): JSX.Element {
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
              fontSize: 24,
              lineHeight: 1.1,
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

/** One segment for each step. The running segment pulses softly, and never when motion is reduced. */
export function StepBar(props: { steps: ReadonlyArray<PanelStep> }): JSX.Element {
  const colours = useStepColours();
  return (
    <Box
      data-step-bar
      role="img"
      aria-label={`${props.steps.length} steps`}
      sx={{
        display: 'flex',
        gap: '2px',
        height: 6,
        minWidth: 0,
        '@keyframes stepPulse': { '0%, 100%': { opacity: 1 }, '50%': { opacity: 0.55 } },
        '& [data-step-state="running"]': {
          animation: 'stepPulse 2.4s ease-in-out infinite',
          '@media (prefers-reduced-motion: reduce)': { animation: 'none' },
        },
      }}
    >
      {props.steps.map((s, i) => (
        <Tooltip
          key={`${s.name}-${i}`}
          title={`${s.name}: ${STEP_WORD[s.state]}`}
          disableInteractive
        >
          <Box
            data-step-state={s.state}
            sx={{ flex: '1 1 0', minWidth: 2, borderRadius: '2px', bgcolor: colours[s.state] }}
          />
        </Tooltip>
      ))}
    </Box>
  );
}

/** The step bar with "step N of M" and the current step name. One line. */
function Progress(props: { steps: ReadonlyArray<PanelStep>; waiting?: boolean }): JSX.Element {
  const tk = useTokens();
  const p = progressOf(props.steps);
  return (
    <Box data-progress sx={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
      {p ? (
        <>
          <Box sx={{ flex: `0 0 ${Math.min(50, 14 + p.total * 3)}%`, minWidth: 0 }}>
            <StepBar steps={props.steps} />
          </Box>
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

function JobRow(props: { job: PanelJob; open: boolean; toggle: () => void }): JSX.Element {
  const { job, open, toggle } = props;
  const tk = useTokens();
  const hasSteps = job.steps.length > 0;
  return (
    <>
      <Box
        data-job={job.id}
        data-open={open ? '' : undefined}
        role={hasSteps ? 'button' : undefined}
        tabIndex={hasSteps ? 0 : undefined}
        aria-expanded={hasSteps ? open : undefined}
        onClick={hasSteps ? toggle : undefined}
        onKeyDown={e => {
          if (hasSteps && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            toggle();
          }
        }}
        sx={{ ...rowSx(tk, 1), cursor: hasSteps ? 'pointer' : 'default' }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: '4px', minWidth: 0 }}>
          <Chevron open={open} show={hasSteps} />
          <Box
            sx={{
              fontSize: 13,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {job.name}
          </Box>
          <Box data-time sx={{ ...TIME_SX, ml: 'auto', minWidth: 52, textAlign: 'right' }}>
            {formatWait(job.seconds)}
          </Box>
        </Box>
        <Box sx={{ pl: '20px' }}>
          <Progress steps={job.steps} waiting={job.state === 'queued'} />
        </Box>
      </Box>
      {open && hasSteps && <StepList steps={job.steps} depth={1} />}
    </>
  );
}

function RunRow(props: {
  run: PanelRun;
  link?: string;
  open: boolean;
  openJobs: ReadonlySet<string>;
  toggle: (id: string) => void;
}): JSX.Element {
  const { run, link, open, openJobs, toggle } = props;
  const tk = useTokens();
  const steps = stepsOfRun(run);
  const expandable = run.jobs.length > 0;
  const repo = (
    <Box
      component="span"
      sx={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis' }}
    >
      {run.repo}
    </Box>
  );
  return (
    <>
      <Box
        data-run={run.id}
        data-run-state={run.state}
        data-open={open ? '' : undefined}
        role={expandable ? 'button' : undefined}
        tabIndex={expandable ? 0 : undefined}
        aria-expanded={expandable ? open : undefined}
        onClick={expandable ? () => toggle(run.id) : undefined}
        onKeyDown={e => {
          if (expandable && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            toggle(run.id);
          }
        }}
        sx={{ ...rowSx(tk, 0), cursor: expandable ? 'pointer' : 'default' }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', gap: '4px', minWidth: 0 }}>
          <Chevron open={open} show={expandable} />
          {link ? (
            <InternalLink to={link} style={{ ...LINK_STYLE, display: 'flex', minWidth: 0 }}>
              {repo}
            </InternalLink>
          ) : (
            repo
          )}
          <Box
            data-run-meta
            sx={{
              fontSize: 11.5,
              color: tk.fg2,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              minWidth: 0,
            }}
          >
            {[run.workflow, run.ref].filter(Boolean).join(' · ')}
          </Box>
          <Box
            data-run-pool
            sx={{
              ml: 'auto',
              flex: 'none',
              fontSize: 11,
              px: '6px',
              borderRadius: '8px',
              color: tk.fg2,
              boxShadow: `inset 0 0 0 1px ${tk.line2}`,
            }}
          >
            {run.pool}
          </Box>
          <Box data-time sx={{ ...TIME_SX, minWidth: 52, textAlign: 'right' }}>
            {formatWait(run.seconds)}
          </Box>
        </Box>
        <Box sx={{ pl: '20px' }}>
          <Progress steps={steps} waiting={run.state === 'queued'} />
        </Box>
      </Box>
      {open &&
        run.jobs.map(job => (
          <JobRow
            key={job.id}
            job={job}
            open={openJobs.has(`${run.id}\u0000${job.id}`)}
            toggle={() => toggle(`${run.id}\u0000${job.id}`)}
          />
        ))}
    </>
  );
}

function QueueRows(props: { rows: QueueRow[]; link?: string }): JSX.Element {
  const tk = useTokens();
  return (
    <>
      {props.rows.map(r => (
        <Box key={r.key} data-queue-row sx={rowSx(tk, 0)}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
            {props.link ? (
              <InternalLink to={props.link} style={{ ...LINK_STYLE, display: 'flex', minWidth: 0 }}>
                <Box
                  component="span"
                  sx={{
                    fontSize: 13,
                    fontWeight: 600,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {r.repo}
                </Box>
              </InternalLink>
            ) : (
              <Box
                component="span"
                sx={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis' }}
              >
                {r.repo}
              </Box>
            )}
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

export function RunnersView(props: {
  model: RunnerModel;
  sourceId: string;
  editing: boolean;
}): JSX.Element {
  const { model, sourceId, editing } = props;
  const tk = useTokens();
  const resolveLink = useResolveLink();
  const root = useElementSize<HTMLDivElement>();
  const [open, setOpen] = React.useState<ReadonlySet<string>>(new Set());
  const toggle = React.useCallback(
    (id: string) =>
      setOpen(prev => {
        const next = new Set(prev);
        if (!next.delete(id)) next.add(id);
        return next;
      }),
    []
  );
  // Every link goes to the runner tab of the dashboard, or is dropped.
  const link = editing ? undefined : resolveLink(model.link, { panelId: 'runners', sourceId });
  const empty = model.tree ? model.runs.length === 0 : model.queue.length === 0;
  return (
    <Box
      ref={root.ref}
      data-runners
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
      <Tiles stats={model.stats} />
      {model.pools.length > 0 && <Pools pools={model.pools} />}
      <ScrollArea label="Running and queued runs">
        {empty ? (
          <Box data-runners-empty sx={{ py: 1, fontSize: 13, color: tk.fg2 }}>
            {EMPTY}
          </Box>
        ) : model.tree ? (
          model.runs.map(run => (
            <RunRow
              key={run.id}
              run={run}
              link={link}
              open={open.has(run.id)}
              openJobs={open}
              toggle={toggle}
            />
          ))
        ) : (
          <QueueRows rows={model.queue} link={link} />
        )}
      </ScrollArea>
      <WidgetFooter status={model.status}>
        <span data-runners-summary>{model.summary}</span>
      </WidgetFooter>
    </Box>
  );
}
