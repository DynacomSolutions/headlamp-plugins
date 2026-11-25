/*
 * Draws the AIS model (see `join.ts`): fixed stat tiles on top, a fixed legend with one colour for
 * each limit window, then one scroll area with the groups. A group is a pool or a provider (its
 * identities that are in no pool). Every identity is one thin line: its name on the left (a small
 * icon before it when the login needs attention, a small dot after it for the served or registry
 * active member of a pool), its limit windows as thin bars stacked in the middle (the colour of a
 * window is the colour of the legend, never written on the line). Every bar has its own lane: the bar, then
 * its countdown (the time to the reset of that window: "3d 4h", "5h 12m"), then its percentage in the status
 * colour of that window. A reset in the past shows "now", muted. A bar with no valid reset shows no
 * countdown. Model windows (for example "Weekly (Fable)") show their own percentage too, but they never set
 * the status of an identity, a pool or the widget (see `join.ts`). All lines (pool, member, provider
 * identity) share the same columns: the name column has one width, so the bars, the countdowns and the
 * percentages stand at the same x on every line, and the indent of a member stays inside the name column.
 * A narrow widget makes the tracks shorter and never drops a countdown or a percentage. One timer redraws the countdowns
 * every 30 s. The tooltip of a line lists every window with its percentage and reset time.
 *
 * The pool is a line of its own with two text rows: the name and "Pool total, N members". Its bars are
 * the joint usage of all members (see `jointLimits`). A member with no data for a window shows an
 * empty dashed lane there. Every row is drawn: nothing folds into a "+N more" line and no group is
 * named "Other". A row links only to a dashboard tab (see `links.tsx`).
 *
 * A narrow widget (under STACK_WIDTH, measured on the widget, not on the window) draws the stat
 * tiles in a small grid on top, then one column of lines.
 */
import Box from '@mui/material/Box';
import ButtonBase from '@mui/material/ButtonBase';
import Tooltip from '@mui/material/Tooltip';
import React from 'react';
import { ScrollArea } from '../../components/ScrollArea';
import { InternalLink, useResolveLink } from '../../links';
import { WidgetFooter } from '../footer';
import { limitColours } from '../panels/limitColours';
import { StatTiles } from '../panels/StatTiles';
import { STATUS_WORD, StatusMark } from '../panels/StatusMark';
import { useTokens } from '../panels/tokens';
import { useElementSize } from '../promql/useElementSize';
import { COUNTDOWN_PAST, COUNTDOWN_TICK_MS, formatCountdown } from './countdown';
import type { AisGroup, AisIdentity, AisJoint, AisModel } from './join';
import { PROVIDER_ICON_SIZE,ProviderIcon } from './providerIcon';

/** A widget at least this wide draws the status key. A row at least WIDE_ROW wide draws wide columns. */
export const WIDE_WIDTH = 640;
export const WIDE_ROW = 520;
/** A widget at least this wide draws the identities of a group in two columns. */
export const TWO_COLUMNS = 1000;
/** An overview widget narrower than this draws its stat tiles in a small grid (see `isStacked`). */
export const STACK_WIDTH = 560;
/** The number of stat tiles in each row of a stacked widget. */
export const STACK_TILE_COLUMNS = 3;
/** True when the widget is narrow: the stat tiles in a grid, no status key. */
export const isStacked = (width: number): boolean => width > 0 && width < STACK_WIDTH;
/** The width of the countdown after each bar, with a gap on the left, in px. */
export const COUNTDOWN_WIDTH = 46;
/** The width of the percentage after each countdown, with a gap on the left, in px. */
export const PERCENT_WIDTH = 32;
/** The least width of the bar track, as in the grid of a line. */
const TRACK_MIN = 24;
/** The width of the name column of every line, in px. The indent of a member is inside it. */
export const nameColumn = (wideRow: boolean): number => (wideRow ? 250 : 186);
/** The indent of a pool member inside the name column, with its rail, in px. */
const MEMBER_INDENT = 12;
/** The height of an identity line and of the pool line, in px. */
export const LINE_HEIGHT = 24;
export const POOL_LINE_HEIGHT = 42;
const GROUP_HEIGHT = 27;
/** The most px of one bar, and of one lane (the bar and its countdown text) in a line. */
const BAR_MAX = 6;
const LANE_MAX = 12;
/** The font size of the countdown and of the percentage of a bar, in px. One size for every line. */
export const LANE_FONT = 8.5;
const clamp = (f: number): number => Math.min(1, Math.max(0, f));

/**
 * The time now in ms, redrawn every COUNTDOWN_TICK_MS. One timer serves the whole widget and the
 * cleanup stops it on unmount. It makes no fetch: the countdowns are derived from the reset times.
 */
export function useNow(tickMs: number = COUNTDOWN_TICK_MS): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), tickMs);
    return () => clearInterval(id);
  }, [tickMs]);
  return now;
}

const LINK_STYLE: React.CSSProperties = { color: 'inherit', textDecoration: 'none' };

/** A reset time for people: "2026-11-22 14:00 UTC" for a valid time, else the text as written. */
export function formatReset(raw: string): string {
  const at = Date.parse(raw);
  return Number.isFinite(at)
    ? `${new Date(at).toISOString().slice(0, 16).replace('T', ' ')} UTC`
    : raw;
}

/** The text of a line for its tooltip and its label: the identity, its login and every window. */
export function lineDetails(
  identity: AisIdentity,
  windows: ReadonlyArray<string>,
  joint?: AisJoint
): string[] {
  const out: string[] = [];
  if (joint) {
    out.push(`${identity.name}: ${poolTotalText(joint.members)}`);
    if (joint.reporting < joint.members)
      out.push(`${joint.reporting} of ${joint.members} members report`);
    for (const l of joint.limits) {
      out.push(
        [
          `${l.name}: ${l.value}`,
          l.reporting < joint.members ? `${l.reporting} of ${joint.members} members report` : '',
          l.resetsAt ? `resets ${formatReset(l.resetsAt)}` : '',
        ]
          .filter(t => t !== '')
          .join(', ')
      );
    }
    return out;
  }
  out.push(`${identity.provider} / ${identity.name}`);
  if (identity.login) out.push(`Login: ${identity.login.word}`);
  for (const name of windows) {
    const l = identity.limits.find(x => x.name === name && x.fraction !== undefined);
    out.push(
      l
        ? `${name}: ${l.value}${l.resetsAt ? `, resets ${formatReset(l.resetsAt)}` : ''}`
        : `${name}: no data`
    );
  }
  return out;
}

const poolTotalText = (members: number): string =>
  `Pool total, ${members} ${members === 1 ? 'member' : 'members'}`;

function Legend(props: { limits: string[]; wide: boolean }): JSX.Element {
  const tk = useTokens();
  const colours = React.useMemo(() => limitColours(props.limits, tk.mode), [props.limits, tk.mode]);
  return (
    <Box
      data-legend
      role="list"
      aria-label="Limits"
      sx={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: '2px 20px',
        alignItems: 'center',
        fontSize: 12.5,
        color: tk.fg2,
        flex: 'none',
      }}
    >
      {props.limits.map(name => {
        const c = colours.get(name);
        return (
          <Box
            key={name}
            role="listitem"
            data-legend-item={name}
            sx={{ display: 'inline-flex', alignItems: 'center', gap: '5px', whiteSpace: 'nowrap' }}
          >
            <Box
              data-swatch={c?.colour}
              sx={{
                width: 18,
                height: 6,
                borderRadius: '3px',
                flex: 'none',
                bgcolor: c?.colour,
                opacity: c?.opacity,
              }}
            />
            {name}
          </Box>
        );
      })}
      {props.wide && (
        <Box sx={{ display: 'inline-flex', gap: 1.5, ml: 'auto' }}>
          {(['crit', 'warn', 'ok'] as const).map(s => (
            <Box key={s} sx={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
              <StatusMark status={s} size={11} />
              {STATUS_WORD[s]}
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );
}

function GroupHeader(props: {
  group: AisGroup;
  link?: string;
  editing: boolean;
  /** A narrow widget: the header wraps, so the note under the name is never cut. */
  stacked?: boolean;
}): JSX.Element {
  const { group, link, editing, stacked } = props;
  const tk = useTokens();
  const n = group.members.length;
  const title = (
    <Box component="span" sx={{ fontSize: 14, fontWeight: 600 }}>
      {group.title}
    </Box>
  );
  return (
    <Box
      data-ais-group={group.key}
      data-group-kind={group.kind}
      role="heading"
      aria-level={3}
      sx={{
        display: 'flex',
        alignItems: 'baseline',
        gap: 1,
        gridColumn: '1 / -1',
        flex: 'none',
        px: 1.5,
        pt: '8px',
        minWidth: 0,
        ...(stacked
          ? { flexWrap: 'wrap', columnGap: 1, rowGap: 0, pb: '2px' }
          : { height: GROUP_HEIGHT, whiteSpace: 'nowrap' }),
        boxShadow: `inset 0 -1px 0 ${tk.line2}`,
      }}
    >
      <Box
        data-group-icon
        sx={{ flex: 'none', alignSelf: 'center', display: 'inline-flex', color: tk.fg }}
      >
        <ProviderIcon name={group.kind === 'pool' ? 'claude' : group.title} />
      </Box>
      {link && !editing ? (
        <InternalLink to={link} style={LINK_STYLE}>
          {title}
        </InternalLink>
      ) : (
        title
      )}
      <Box component="span" sx={{ fontSize: 12, color: tk.fg2, minWidth: 0 }}>
        {n} {n === 1 ? 'identity' : 'identities'}
      </Box>
    </Box>
  );
}

/** The small marks after a name: the served member (a dot) and the registry active member (a ring). */
function MemberMarks(props: { identity: AisIdentity }): JSX.Element {
  const { identity } = props;
  const tk = useTokens();
  const registryOnly = identity.active && !identity.serving;
  return (
    <>
      {identity.serving && (
        <Box
          component="span"
          data-serving-mark
          role="img"
          aria-label="Serving"
          title="The gateway served this member last, so the agents of the pool run as this login now."
          sx={{ flex: 'none', width: 7, height: 7, borderRadius: '50%', bgcolor: tk.status.ok }}
        />
      )}
      {registryOnly && (
        <Box
          component="span"
          data-active-mark
          role="img"
          aria-label={identity.serving === undefined ? 'Active' : 'Registry active'}
          title={
            identity.serving === undefined
              ? 'The registry lists this member as active.'
              : 'The registry lists this member as active, but the gateway serves another member.'
          }
          sx={{
            flex: 'none',
            width: 7,
            height: 7,
            borderRadius: '50%',
            boxShadow: `inset 0 0 0 1.5px ${
              identity.serving === undefined ? tk.status.ok : tk.fg2
            }`,
          }}
        />
      )}
    </>
  );
}

/** The window names to draw on a line: those of its pool first, then its own, in the display order. */
function laneNames(
  identity: AisIdentity,
  order: ReadonlyArray<string>,
  poolWindows: ReadonlyArray<string>
): string[] {
  const own = identity.limits.filter(l => l.fraction !== undefined).map(l => l.name);
  return order.filter(n => own.includes(n) || poolWindows.includes(n));
}

/**
 * One thin line: the name (with a login icon and the marks) and the stacked bars, each with its
 * countdown and its percentage. The pool line is the same grid with a second text row under the name.
 */
function IdentityLine(props: {
  identity: AisIdentity;
  /** The windows to draw, in the display order. A window that the identity lacks is drawn empty. */
  windows: string[];
  colours: ReturnType<typeof limitColours>;
  /** The time now in ms, for the countdowns. */
  now: number;
  link?: string;
  editing: boolean;
  wide: boolean;
  /** A pool line: the joint usage, the line under the name and a toggle in front. */
  pool?: {
    joint: AisJoint;
    sub: string;
    open: boolean;
    onToggle: () => void;
  };
  /** A member of a pool: drawn one step in. */
  indent?: boolean;
}): JSX.Element {
  const { identity, windows, colours, now, link, editing, wide, pool, indent } = props;
  const tk = useTokens();
  const height = pool ? POOL_LINE_HEIGHT : LINE_HEIGHT;
  const laneTrack = tk.mode === 'dark' ? 'rgba(255,255,255,0.09)' : 'rgba(0,0,0,0.07)';
  const login = identity.login;
  const loginProblem = !pool && (login?.status === 'warn' || login?.status === 'crit');
  const details = lineDetails(identity, windows, pool?.joint);
  const hasData = windows.some(w =>
    identity.limits.some(l => l.name === w && l.fraction !== undefined)
  );
  // The lanes fill the height of the line, so the line never grows. A lane holds one bar, its
  // countdown and its percentage.
  const lane = Math.max(1, Math.min(LANE_MAX, Math.floor(height / Math.max(1, windows.length))));
  const barHeight = Math.max(1, Math.min(pool ? 5 : BAR_MAX, lane - 2));
  const name = (
    <Box component="span" sx={{ fontSize: pool ? 14 : 13, fontWeight: pool ? 600 : undefined }}>
      {identity.name}
    </Box>
  );
  return (
    <Tooltip
      placement="top-start"
      enterDelay={250}
      title={
        <Box data-line-tip sx={{ fontSize: 12, lineHeight: 1.5 }}>
          {details.map((d, i) => (
            <div key={i}>{d}</div>
          ))}
        </Box>
      }
    >
      <Box
        data-ais-row={identity.key}
        data-row-status={identity.status}
        data-line
        data-active={identity.active ? '' : undefined}
        data-serving={identity.serving ? '' : undefined}
        sx={{
          display: 'grid',
          gridTemplateColumns: `${nameColumn(wide)}px minmax(${
            TRACK_MIN + COUNTDOWN_WIDTH + PERCENT_WIDTH
          }px, 1fr)`,
          columnGap: '10px',
          alignItems: 'center',
          height,
          flex: 'none',
          minWidth: 0,
          pl: 1.5,
          pr: 1.5,
          ...(pool ? { gridColumn: '1 / -1' } : {}),
          bgcolor: loginProblem && login ? tk.fill[login.status] : 'transparent',
          boxShadow: pool ? `inset 0 -1px 0 ${tk.line2}` : `inset 0 -1px 0 ${tk.line}`,
        }}
      >
        <Box
          data-ais-label
          sx={{
            minWidth: 0,
            lineHeight: 1.15,
            // The indent of a member and its rail stay inside the name column, so the bars of
            // every line start at the same x.
            ...(indent
              ? {
                  alignSelf: 'stretch',
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'center',
                  ml: `${MEMBER_INDENT}px`,
                  pl: '10px',
                  borderLeft: `2px solid ${tk.line2}`,
                }
              : {}),
          }}
        >
          <Box sx={{ display: 'flex', alignItems: 'center', gap: '5px', minWidth: 0 }}>
            {pool && (
              <ButtonBase
                data-pool-toggle
                aria-expanded={pool.open}
                aria-label={`${pool.open ? 'Fold' : 'Expand'} ${identity.name}`}
                onClick={pool.onToggle}
                sx={{ flex: 'none', fontSize: 12, width: 16, height: 16, color: tk.fg2 }}
              >
                {pool.open ? '▾' : '▸'}
              </ButtonBase>
            )}
            {pool && (
              <Box data-pool-icon sx={{ flex: 'none', display: 'inline-flex', color: tk.fg }}>
                <ProviderIcon name="claude" />
              </Box>
            )}
            {loginProblem && login && (
              <Box
                component="span"
                data-login={login.status}
                title={`Login: ${login.word}`}
                sx={{ display: 'inline-flex', flex: 'none' }}
              >
                <StatusMark status={login.status} size={11} />
              </Box>
            )}
            <Box
              sx={{
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {link && !editing ? (
                <InternalLink to={link} style={LINK_STYLE}>
                  {name}
                </InternalLink>
              ) : (
                name
              )}
            </Box>
            <MemberMarks identity={identity} />
          </Box>
          {pool && (
            <Box
              component="span"
              data-pool-sub
              sx={{
                display: 'block',
                pl: `${16 + 5 + PROVIDER_ICON_SIZE + 5}px`,
                fontSize: 11.5,
                color: tk.mut,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {pool.sub}
            </Box>
          )}
        </Box>
        {hasData ? (
          <Box
            data-bar
            role="img"
            aria-label={details.join('. ')}
            sx={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}
          >
            {windows.map(laneName => {
              const limit = identity.limits.find(
                l => l.name === laneName && l.fraction !== undefined
              );
              const c = colours.get(laneName);
              const f = clamp(limit?.fraction ?? 0);
              const text = limit ? formatCountdown(limit.resetsAt, now) : '';
              const past = text === COUNTDOWN_PAST;
              return (
                <Box
                  key={laneName}
                  data-lane={laneName}
                  data-missing={limit ? undefined : ''}
                  sx={{ display: 'flex', alignItems: 'center', height: lane, minWidth: 0 }}
                >
                  <Box
                    data-track
                    sx={{
                      flex: '1 1 0',
                      minWidth: 0,
                      height: barHeight,
                      position: 'relative',
                      borderRadius: '2px',
                      overflow: 'hidden',
                      bgcolor: limit ? laneTrack : 'transparent',
                      ...(limit ? {} : { boxShadow: `inset 0 0 0 1px ${tk.line2}` }),
                    }}
                  >
                    {limit && (
                      <Box
                        data-segment={laneName}
                        data-fill={limit.fraction}
                        sx={{
                          position: 'absolute',
                          left: 0,
                          top: 0,
                          bottom: 0,
                          width: f > 0 ? `max(2px, ${f * 100}%)` : 0,
                          borderRadius: '2px',
                          bgcolor: c?.colour,
                          opacity: c?.opacity,
                        }}
                      />
                    )}
                  </Box>
                  <Box
                    data-countdown={text === '' ? undefined : laneName}
                    data-countdown-past={past ? '' : undefined}
                    sx={{
                      // A fixed width with a gap on the left: the tracks of all lines end in
                      // the same column and the text never touches the bar.
                      flex: 'none',
                      width: COUNTDOWN_WIDTH,
                      boxSizing: 'border-box',
                      pl: '4px',
                      overflow: 'hidden',
                      textAlign: 'right',
                      whiteSpace: 'nowrap',
                      fontSize: LANE_FONT,
                      lineHeight: `${lane}px`,
                      fontVariantNumeric: 'tabular-nums',
                      color: past ? tk.mut : tk.fg2,
                    }}
                  >
                    {text !== '' && <span data-countdown-text>{text}</span>}
                  </Box>
                  <Box
                    data-percent={limit ? laneName : undefined}
                    data-status={limit?.status}
                    sx={{
                      flex: 'none',
                      width: PERCENT_WIDTH,
                      boxSizing: 'border-box',
                      pl: '6px',
                      overflow: 'hidden',
                      textAlign: 'right',
                      whiteSpace: 'nowrap',
                      fontSize: LANE_FONT,
                      lineHeight: `${lane}px`,
                      fontVariantNumeric: 'tabular-nums',
                      color: limit ? tk.status[limit.status] : tk.mut,
                    }}
                  >
                    {limit?.value ?? ''}
                  </Box>
                </Box>
              );
            })}
          </Box>
        ) : (
          <Box data-no-limits sx={{ fontSize: 11.5, color: tk.mut }}>
            {pool ? 'No member reports' : 'No limit data'}
          </Box>
        )}
      </Box>
    </Tooltip>
  );
}

/** The pool as an identity: the joint limits of all members and the joint status. */
function poolIdentity(group: AisGroup, joint: AisJoint): AisIdentity {
  return {
    key: group.key,
    name: group.title,
    provider: 'Pool',
    limits: joint.limits,
    active: false,
    status: joint.status,
    link: group.link,
  };
}

/** The line under a pool name: what the bars are, and how many members report. */
export function poolSub(joint: AisJoint): string {
  return joint.reporting < joint.members
    ? `Pool total, ${joint.reporting} of ${joint.members} members report`
    : poolTotalText(joint.members);
}

export type AisViewMode = 'overview' | 'console';

export function AisView(props: {
  model: AisModel;
  sourceId: string;
  kiosk: boolean;
  editing: boolean;
  /** `console` is the AIS tab: one list, no stat tiles. */
  view?: AisViewMode;
}): JSX.Element {
  const { model, sourceId, editing } = props;
  const consoleView = props.view === 'console';
  const tk = useTokens();
  const now = useNow();
  const resolveLink = useResolveLink();
  const root = useElementSize<HTMLDivElement>();
  // A pool is open until the user folds it. The state belongs to the widget, not to the data.
  const [folded, setFolded] = React.useState<ReadonlySet<string>>(new Set());
  const toggle = (key: string): void =>
    setFolded(prev => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  const columns = !consoleView && root.size.width >= TWO_COLUMNS ? 2 : 1;
  const wide = root.size.width >= WIDE_WIDTH;
  const wideRow = root.size.width / columns >= WIDE_ROW;
  const stacked = !consoleView && isStacked(root.size.width);
  const colours = React.useMemo(() => limitColours(model.limits, tk.mode), [model.limits, tk.mode]);
  // Every link goes to the AIS tab of the dashboard, or is dropped.
  const linkOf = (raw: string | undefined): string | undefined =>
    resolveLink(raw, { panelId: 'ais', sourceId });
  return (
    <Box
      ref={root.ref}
      data-ais
      data-ais-view={consoleView ? 'console' : 'overview'}
      data-ais-layout={stacked ? 'stacked' : wide ? 'wide' : 'compact'}
      sx={{
        display: 'flex',
        flexDirection: 'column',
        gap: 1,
        minWidth: 0,
        height: '100%',
        minHeight: 0,
        overflow: 'hidden',
      }}
    >
      {!consoleView && model.stats.length > 0 && (
        <StatTiles
          stats={model.stats}
          width={root.size.width}
          textTiles={model.textTiles}
          columns={stacked ? STACK_TILE_COLUMNS : undefined}
        />
      )}
      {model.limits.length > 0 && <Legend limits={model.limits} wide={wide} />}
      <ScrollArea label="Limits by pool and identity">
        <Box
          data-ais-list
          data-columns={columns}
          sx={{
            display: 'grid',
            gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
            columnGap: '28px',
            alignContent: 'start',
            minWidth: 0,
          }}
        >
          {model.groups.map(group => {
            const pool = group.kind === 'pool' && group.joint ? group : undefined;
            const open = !folded.has(group.key);
            const poolWindows = pool?.joint?.limits.map(l => l.name) ?? [];
            return (
              <React.Fragment key={group.key}>
                {pool && pool.joint ? (
                  <IdentityLine
                    identity={poolIdentity(pool, pool.joint)}
                    windows={model.limits.filter(n => poolWindows.includes(n))}
                    colours={colours}
                    now={now}
                    link={linkOf(pool.link)}
                    editing={editing}
                    wide={wideRow}
                    pool={{
                      joint: pool.joint,
                      sub: poolSub(pool.joint),
                      open,
                      onToggle: () => toggle(group.key),
                    }}
                  />
                ) : (
                  <GroupHeader
                    group={group}
                    link={linkOf(group.link)}
                    editing={editing}
                    stacked={stacked}
                  />
                )}
                {(!pool || open) &&
                  group.members.map(identity => (
                    <IdentityLine
                      key={identity.key}
                      identity={identity}
                      windows={laneNames(identity, model.limits, poolWindows)}
                      colours={colours}
                      now={now}
                      link={linkOf(identity.link)}
                      editing={editing}
                      wide={wideRow}
                      indent={pool !== undefined}
                    />
                  ))}
              </React.Fragment>
            );
          })}
        </Box>
      </ScrollArea>
      <WidgetFooter status={model.status}>
        <span data-ais-summary>
          {consoleView && model.loginSummary !== ''
            ? `${model.summary}. Logins: ${model.loginSummary}`
            : model.summary}
        </span>
      </WidgetFooter>
    </Box>
  );
}
