/*
 * Draws the AIS model (see `join.ts`): fixed stat tiles on top, a fixed legend of the limit
 * windows, then one scroll area with the groups. A group is a pool (its members under it, the active
 * one marked) or a provider (its identities that are in no pool). An identity row has its login
 * state, one lane for each limit window, and its worst limit with the status mark at the end. Every
 * row is drawn: nothing folds into a "+N more" line and no group is named "Other". A row links
 * only to a dashboard tab (see `links.tsx`).
 */
import Box from '@mui/material/Box';
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
import type { AisGroup, AisIdentity, AisLimit, AisModel } from './join';

/** A widget at least this wide draws the status key. A row at least WIDE_ROW wide draws wide columns. */
export const WIDE_WIDTH = 640;
export const WIDE_ROW = 520;
/** A widget at least this wide draws the identities of a group in two columns. */
export const TWO_COLUMNS = 1000;
const ROW_HEIGHT = { wide: 42, narrow: 40 };
const GROUP_HEIGHT = 30;
const BAR_MAX = 26;
const clamp = (f: number): number => Math.min(1, Math.max(0, f));
const RANK = { ok: 0, unknown: 1, warn: 2, crit: 3 } as const;

/** The limit that sets the note of a row: the worst status, then the largest fraction. */
export function worstLimit(limits: ReadonlyArray<AisLimit>): AisLimit | undefined {
  let worst: AisLimit | undefined;
  for (const l of limits) {
    if (
      !worst ||
      RANK[l.status] > RANK[worst.status] ||
      (RANK[l.status] === RANK[worst.status] && (l.fraction ?? 0) > (worst.fraction ?? 0))
    )
      worst = l;
  }
  return worst;
}

const fullCount = (limits: ReadonlyArray<AisLimit>): number =>
  limits.filter(l => (l.fraction ?? 0) >= 0.995).length;

const LINK_STYLE: React.CSSProperties = { color: 'inherit', textDecoration: 'none' };

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

function GroupHeader(props: { group: AisGroup; link?: string; editing: boolean }): JSX.Element {
  const { group, link, editing } = props;
  const tk = useTokens();
  const n = group.members.length;
  const noun =
    group.kind === 'pool' ? (n === 1 ? 'member' : 'members') : n === 1 ? 'identity' : 'identities';
  const title = (
    <Box component="span" sx={{ fontSize: 15, fontWeight: 600 }}>
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
        gap: 1.25,
        height: GROUP_HEIGHT,
        gridColumn: '1 / -1',
        flex: 'none',
        px: 1.5,
        pt: '8px',
        minWidth: 0,
        whiteSpace: 'nowrap',
        boxShadow: `inset 0 -1px 0 ${tk.line2}`,
      }}
    >
      {link && !editing ? (
        <InternalLink to={link} style={LINK_STYLE}>
          {title}
        </InternalLink>
      ) : (
        title
      )}
      {group.kind === 'pool' && (
        <Box
          component="span"
          data-pool-chip
          sx={{
            fontSize: 11,
            px: '6px',
            borderRadius: '8px',
            boxShadow: `inset 0 0 0 1px ${tk.line2}`,
            color: tk.fg2,
          }}
        >
          Pool
        </Box>
      )}
      <Box component="span" sx={{ fontSize: 12.5, color: tk.fg2 }}>
        {n} {noun}
        {group.kind === 'pool' && group.active ? `, active ${group.active}` : ''}
      </Box>
    </Box>
  );
}

function LoginLine(props: { identity: AisIdentity }): JSX.Element {
  const { identity } = props;
  const tk = useTokens();
  const login = identity.login;
  if (!login) {
    return (
      <Box component="span" data-login="unknown" sx={{ fontSize: 11.5, color: tk.mut }}>
        No login data
      </Box>
    );
  }
  const problem = login.status === 'warn' || login.status === 'crit';
  return (
    <Box
      component="span"
      data-login={login.status}
      title={login.detail}
      sx={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        fontSize: 11.5,
        color: problem ? tk.fg : tk.mut,
      }}
    >
      {problem && <StatusMark status={login.status} size={10} />}
      {login.word}
    </Box>
  );
}

function IdentityRow(props: {
  identity: AisIdentity;
  limits: string[];
  colours: ReturnType<typeof limitColours>;
  link?: string;
  editing: boolean;
  wide: boolean;
}): JSX.Element {
  const { identity, limits, colours, link, editing, wide } = props;
  const tk = useTokens();
  const height = wide ? ROW_HEIGHT.wide : ROW_HEIGHT.narrow;
  const lanes = limits
    .map(name => ({ name, limit: identity.limits.find(l => l.name === name) }))
    .filter(x => x.limit && x.limit.fraction !== undefined);
  const worst = worstLimit(identity.limits);
  const full = fullCount(identity.limits);
  const barHeight = Math.min(BAR_MAX, height - 12);
  const laneTrack = tk.mode === 'dark' ? 'rgba(255,255,255,0.09)' : 'rgba(0,0,0,0.07)';
  const loginProblem = identity.login?.status === 'warn' || identity.login?.status === 'crit';
  const summary = [
    `${identity.provider} ${identity.name}`,
    identity.login ? identity.login.word : 'no login data',
    ...identity.limits.map(l => `${l.name}: ${l.value}`),
    STATUS_WORD[identity.status],
  ].join('. ');
  const name = (
    <Box component="span" sx={{ fontSize: 15 }}>
      {identity.name}
    </Box>
  );
  return (
    <Box
      data-ais-row={identity.key}
      data-row-status={identity.status}
      data-active={identity.active ? '' : undefined}
      sx={{
        display: 'grid',
        gridTemplateColumns: `${wide ? 230 : 140}px minmax(40px, 1fr) ${wide ? 150 : 84}px 14px`,
        columnGap: wide ? '16px' : '12px',
        alignItems: 'center',
        height,
        flex: 'none',
        minWidth: 0,
        px: 1.5,
        // A login that needs attention tints the row, like a band in the other lists.
        bgcolor: loginProblem && identity.login ? tk.fill[identity.login.status] : 'transparent',
        boxShadow: `inset 0 -1px 0 ${tk.line}`,
      }}
    >
      <Tooltip title={`${identity.provider} / ${identity.name}`} placement="top-start">
        <Box data-ais-label sx={{ minWidth: 0, lineHeight: 1.2 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, minWidth: 0 }}>
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
            {identity.active && (
              <Box
                component="span"
                data-active-chip
                sx={{
                  flex: 'none',
                  fontSize: 11,
                  px: '6px',
                  borderRadius: '8px',
                  color: tk.fg,
                  bgcolor: tk.fill.ok,
                  boxShadow: `inset 0 0 0 1px ${tk.status.ok}`,
                }}
              >
                Active
              </Box>
            )}
          </Box>
          <LoginLine identity={identity} />
        </Box>
      </Tooltip>
      {lanes.length > 0 ? (
        <Box
          data-bar
          role="img"
          aria-label={summary}
          sx={{
            display: 'flex',
            flexDirection: 'column',
            height: barHeight,
            gap: wide ? '2px' : '1px',
            minWidth: 0,
          }}
        >
          {lanes.map(({ name: lane, limit }) => {
            const c = colours.get(lane);
            const f = clamp(limit?.fraction ?? 0);
            return (
              <Box
                key={lane}
                data-lane={lane}
                title={`${lane}: ${limit?.value}`}
                sx={{
                  flex: '1 1 0',
                  minHeight: '1px',
                  position: 'relative',
                  borderRadius: '3px',
                  overflow: 'hidden',
                  bgcolor: laneTrack,
                }}
              >
                <Box
                  data-segment={lane}
                  data-fill={limit?.fraction}
                  sx={{
                    position: 'absolute',
                    left: 0,
                    top: 0,
                    bottom: 0,
                    width: f > 0 ? `max(2px, ${f * 100}%)` : 0,
                    borderRadius: '3px',
                    bgcolor: c?.colour,
                    opacity: c?.opacity,
                  }}
                />
              </Box>
            );
          })}
        </Box>
      ) : (
        <Box data-no-limits sx={{ fontSize: 12.5, color: tk.mut }}>
          No limit data
        </Box>
      )}
      <Box
        data-ais-note
        sx={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-end',
          lineHeight: 1.15,
          whiteSpace: 'nowrap',
          minWidth: 0,
        }}
      >
        {worst && (
          <>
            <Box component="span" sx={{ fontSize: 17, fontVariantNumeric: 'tabular-nums' }}>
              {worst.value}
            </Box>
            <Box
              component="span"
              sx={{ fontSize: 11.5, color: tk.mut, overflow: 'hidden', textOverflow: 'ellipsis' }}
            >
              {worst.name}
              {wide && full > 1 && ` · ${full} limits full`}
            </Box>
          </>
        )}
      </Box>
      <Box data-ais-status sx={{ display: 'flex', justifyContent: 'flex-end' }}>
        <StatusMark status={identity.status} size={13} />
      </Box>
    </Box>
  );
}

export function AisView(props: {
  model: AisModel;
  sourceId: string;
  kiosk: boolean;
  editing: boolean;
}): JSX.Element {
  const { model, sourceId, editing } = props;
  const tk = useTokens();
  const resolveLink = useResolveLink();
  const root = useElementSize<HTMLDivElement>();
  const columns = root.size.width >= TWO_COLUMNS ? 2 : 1;
  const wide = root.size.width >= WIDE_WIDTH;
  const wideRow = root.size.width / columns >= WIDE_ROW;
  const colours = React.useMemo(() => limitColours(model.limits, tk.mode), [model.limits, tk.mode]);
  // Every link goes to the AIS tab of the dashboard, or is dropped.
  const linkOf = (raw: string | undefined): string | undefined =>
    resolveLink(raw, { panelId: 'ais', sourceId });
  return (
    <Box
      ref={root.ref}
      data-ais
      sx={{
        display: 'flex',
        flexDirection: 'column',
        gap: 1.25,
        minWidth: 0,
        height: '100%',
        minHeight: 0,
        overflow: 'hidden',
      }}
    >
      {model.stats.length > 0 && (
        <StatTiles stats={model.stats} width={root.size.width} textTiles={model.textTiles} />
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
          {model.groups.map(group => (
            <React.Fragment key={group.key}>
              <GroupHeader group={group} link={linkOf(group.link)} editing={editing} />
              {group.members.map(identity => (
                <IdentityRow
                  key={identity.key}
                  identity={identity}
                  limits={model.limits}
                  colours={colours}
                  link={linkOf(identity.link)}
                  editing={editing}
                  wide={wideRow}
                />
              ))}
            </React.Fragment>
          ))}
        </Box>
      </ScrollArea>
      <WidgetFooter status={model.status}>
        <span data-ais-summary>{model.summary}</span>
      </WidgetFooter>
    </Box>
  );
}
