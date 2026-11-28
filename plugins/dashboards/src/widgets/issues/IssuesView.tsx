/*
 * Draws the issues model (see `join.ts`): two fixed rows of stat tiles (the alerts, then the
 * incidents), one scroll area with a row for each issue group, and the summary line in the frame
 * footer. A group row has the severity mark, the alert name, a count badge and the state on the
 * first line, the target and the agent chip on the second line, and the likely cause on the third
 * line of a diagnosed group. Every group is drawn: nothing folds into a "+N more" line and no group
 * is named "Other". A row links only to the Incidents page or the Incidents tab (see `links.tsx`).
 */
import Box from '@mui/material/Box';
import { alpha } from '@mui/material/styles';
import React from 'react';
import { ScrollArea } from '../../components/ScrollArea';
import { InternalLink, LinkContext, useResolveLink } from '../../links';
import { buildPath, safeDecode } from '../../urlState';
import { WidgetFooter } from '../footer';
import { StatTiles } from '../panels/StatTiles';
import { STATUS_WORD, StatusMark } from '../panels/StatusMark';
import { useTokens } from '../panels/tokens';
import { useElementSize } from '../promql/useElementSize';
import type { AgentState, IssueGroup, IssuesModel, IssueState } from './join';

export const STATE_WORD: Record<IssueState, string> = {
  firing: 'Firing',
  pending: 'Pending',
  open: 'Open',
  resolved: 'Resolved',
};

export const AGENT_WORD: Record<Exclude<AgentState, 'none'>, string> = {
  working: 'Agent working',
  diagnosed: 'Diagnosed',
  failed: 'Failed',
  skipped: 'Not investigated',
};

/** The two tile rows share their column widths. The third tile gets more room for "Resolved today". */
const TILE_WEIGHTS = [1, 1, 1.5];

const LINK_STYLE: React.CSSProperties = {
  color: 'inherit',
  textDecoration: 'none',
  display: 'block',
};

/** The shape in front of an agent chip: a dot for work, a tick for a diagnosis, a cross for a failure. */
function AgentMark(props: { agent: Exclude<AgentState, 'none'>; colour: string }): JSX.Element {
  const { agent, colour } = props;
  return (
    <svg width={11} height={11} viewBox="0 0 12 12" aria-hidden style={{ flex: 'none' }}>
      {agent === 'working' && <circle cx="6" cy="6" r="4.5" fill={colour} />}
      {agent === 'diagnosed' && (
        <path d="M2 6.5 L5 9.5 L10 2.5" fill="none" stroke={colour} strokeWidth="1.8" />
      )}
      {agent === 'skipped' && (
        <circle cx="6" cy="6" r="4" fill="none" stroke={colour} strokeWidth="1.4" />
      )}
      {agent === 'failed' && (
        <path
          d="M2.5 2.5 L9.5 9.5 M9.5 2.5 L2.5 9.5"
          fill="none"
          stroke={colour}
          strokeWidth="1.8"
        />
      )}
    </svg>
  );
}

function AgentChip(props: { agent: Exclude<AgentState, 'none'> }): JSX.Element {
  const { agent } = props;
  const tk = useTokens();
  const working = agent === 'working';
  const colour = working ? tk.info : tk.fg2;
  return (
    <Box
      component="span"
      data-issue-agent={agent}
      sx={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '5px',
        flex: 'none',
        px: '8px',
        py: '1px',
        borderRadius: '10px',
        fontSize: 11.5,
        lineHeight: 1.4,
        whiteSpace: 'nowrap',
        color: tk.fg,
        bgcolor: working ? alpha(tk.info, tk.mode === 'dark' ? 0.2 : 0.14) : 'transparent',
        boxShadow: `inset 0 0 0 1px ${working ? tk.info : tk.line2}`,
      }}
    >
      <AgentMark agent={agent} colour={colour} />
      {AGENT_WORD[agent]}
    </Box>
  );
}

function GroupRow(props: { group: IssueGroup; link?: string; editing: boolean }): JSX.Element {
  const { group, link, editing } = props;
  const tk = useTokens();
  const edge =
    group.status === 'crit' || group.status === 'warn' ? tk.status[group.status] : 'transparent';
  const parts = [
    `${group.name}${group.target ? ` on ${group.target}` : ''}`,
    `${STATUS_WORD[group.status]}`,
    STATE_WORD[group.state],
    `${group.count} ${group.count === 1 ? 'item' : 'items'}`,
    group.agent !== 'none' ? AGENT_WORD[group.agent] : '',
  ].filter(Boolean);
  const body = (
    <Box
      data-issue-group={group.key}
      data-issue-status={group.status}
      data-issue-state={group.state}
      role="group"
      aria-label={parts.join('. ')}
      sx={{
        display: 'grid',
        gridTemplateColumns: '14px minmax(0, 1fr)',
        columnGap: '10px',
        alignItems: 'start',
        minWidth: 0,
        px: 1.5,
        py: '8px',
        boxShadow: `inset 3px 0 0 ${edge}, inset 0 -1px 0 ${tk.line}`,
        bgcolor:
          group.status === 'crit' || group.status === 'warn'
            ? tk.fill[group.status]
            : 'transparent',
        '&:hover': { bgcolor: tk.hover },
      }}
    >
      <Box sx={{ display: 'flex', pt: '5px' }}>
        <StatusMark status={group.status} size={13} />
      </Box>
      <Box sx={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: '3px' }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0, lineHeight: 1.25 }}>
          <Box
            data-issue-name
            title={group.name}
            sx={{
              flex: '0 1 auto',
              minWidth: 0,
              fontSize: 15,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {group.name}
          </Box>
          <Box
            component="span"
            data-issue-count={group.count}
            title={`${group.alerts} ${group.alerts === 1 ? 'alert' : 'alerts'}, ${
              group.incidents
            } ${group.incidents === 1 ? 'incident' : 'incidents'}`}
            sx={{
              flex: 'none',
              fontSize: 12,
              fontVariantNumeric: 'tabular-nums',
              px: '7px',
              borderRadius: '9px',
              color: tk.fg,
              bgcolor: tk.hover,
              boxShadow: `inset 0 0 0 1px ${tk.line2}`,
            }}
          >
            {group.count}
          </Box>
          <Box
            component="span"
            data-issue-state-word
            sx={{ flex: 'none', ml: 'auto', fontSize: 12.5, color: tk.fg2, whiteSpace: 'nowrap' }}
          >
            {STATE_WORD[group.state]}
          </Box>
        </Box>
        {(group.target !== '' || group.agent !== 'none') && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}>
            <Box
              data-issue-target
              title={group.target}
              sx={{
                flex: '1 1 0',
                minWidth: 0,
                fontSize: 12.5,
                color: tk.fg2,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {group.target}
            </Box>
            {group.agent !== 'none' && <AgentChip agent={group.agent} />}
          </Box>
        )}
        {group.agent === 'diagnosed' && group.cause !== '' && (
          <Box
            data-issue-cause
            title={group.cause}
            sx={{
              fontSize: 12,
              lineHeight: 1.35,
              color: tk.mut,
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
            }}
          >
            {group.cause}
          </Box>
        )}
      </Box>
    </Box>
  );
  return link && !editing ? (
    <InternalLink to={link} style={LINK_STYLE}>
      {body}
    </InternalLink>
  ) : (
    body
  );
}

export function IssuesView(props: {
  model: IssuesModel;
  sourceId: string;
  editing: boolean;
}): JSX.Element {
  const { model, sourceId, editing } = props;
  const resolveLink = useResolveLink();
  const root = useElementSize<HTMLDivElement>();
  const targets = React.useContext(LinkContext);
  // Every link stays on this dashboard, or is dropped. A link to one incident selects it on the
  // Incidents tab (`<tab>/incident/<id>`, the focus path of the Incidents list widget).
  const linkOf = (raw: string | undefined): string | undefined => {
    const id = /\/incidents\/([^/?#]+)$/.exec(raw ?? '')?.[1];
    if (id && targets?.tabs.includes('incidents'))
      return buildPath(
        { name: targets.dashboard, tab: 'incidents', focus: ['incident', safeDecode(id)] },
        targets.base
      );
    return resolveLink(raw, { panelId: 'incidents', sourceId });
  };
  const all = [...model.alertStats, ...model.incidentStats];
  return (
    <Box
      ref={root.ref}
      data-issues
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
      <Box data-issues-tiles sx={{ flex: 'none' }}>
        <StatTiles
          stats={model.alertStats}
          width={root.size.width}
          sizeFrom={all}
          weights={TILE_WEIGHTS}
        />
        <StatTiles
          stats={model.incidentStats}
          width={root.size.width}
          sizeFrom={all}
          weights={TILE_WEIGHTS}
        />
      </Box>
      <ScrollArea label="Alerts and incidents by issue">
        <Box data-issues-list sx={{ minWidth: 0 }}>
          {model.groups.map(g => (
            <GroupRow key={g.key} group={g} link={linkOf(g.link)} editing={editing} />
          ))}
        </Box>
      </ScrollArea>
      <WidgetFooter status={model.status}>
        <span data-issues-summary>{model.summary}</span>
      </WidgetFooter>
    </Box>
  );
}
