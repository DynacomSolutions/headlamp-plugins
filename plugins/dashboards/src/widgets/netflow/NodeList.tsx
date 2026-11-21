/*
 * The node list under the graph: one thin line for each node with the drop and error share of each
 * interface group and the TCP retransmit share. The header stays fixed, the rows scroll, and no row
 * is folded into a "+N more" line. A status mark gives the shape cue for the worst group.
 */
import Box from '@mui/material/Box';
import React from 'react';
import { ScrollArea } from '../../components/ScrollArea';
import type { PanelStatus } from '../panels/model';
import { StatusMark } from '../panels/StatusMark';
import { cellStatus } from '../promql/matrix';
import type { Ink } from '../promql/palette';
import { formatShare, GROUPS, NodeHealth } from './model';

const COLUMNS = 'minmax(0, 1.25fr) repeat(4, minmax(0, 1fr))';

export function NodeList({
  health,
  ink,
  line,
  colours,
  nodeWarnAbove,
  nodeCritAbove,
}: {
  health: NodeHealth[];
  ink: Ink;
  line: string;
  colours: Record<PanelStatus, string>;
  nodeWarnAbove: number;
  nodeCritAbove: number;
}): JSX.Element {
  const value = (v: number | null, status: PanelStatus) => (
    <Box
      component="span"
      sx={{
        textAlign: 'right',
        fontVariantNumeric: 'tabular-nums',
        color:
          v === null
            ? ink.muted
            : status === 'warn' || status === 'crit'
            ? colours[status]
            : ink.primary,
        fontWeight: status === 'crit' ? 700 : 400,
      }}
    >
      {v === null ? '-' : formatShare(v)}
    </Box>
  );
  const head = {
    color: ink.secondary,
    fontSize: 11,
    fontWeight: 600,
    textAlign: 'right',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  } as const;
  return (
    <Box
      data-flow-list
      sx={{ flex: '1 1 0', minHeight: 0, display: 'flex', flexDirection: 'column' }}
    >
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: COLUMNS,
          columnGap: 0.75,
          alignItems: 'center',
          pl: '18px',
          pr: '8px',
          py: '2px',
          borderBottom: `1px solid ${line}`,
          flex: 'none',
        }}
      >
        <Box
          component="span"
          sx={{ ...head, textAlign: 'left' }}
          title="Drop and error share per interface group, and TCP retransmit share"
        >
          Node
        </Box>
        {GROUPS.map(g => (
          <Box
            key={g.id}
            component="span"
            sx={head}
            title={`${g.label}: dropped and failed packets`}
          >
            {g.label}
          </Box>
        ))}
        <Box component="span" sx={head} title="TCP segments sent again">
          TCP retx
        </Box>
      </Box>
      <ScrollArea label="Nodes">
        {health.map(h => (
          <Box
            key={h.name}
            data-flow-row={h.name}
            data-status={h.status}
            sx={{
              display: 'grid',
              gridTemplateColumns: COLUMNS,
              columnGap: 0.75,
              alignItems: 'center',
              position: 'relative',
              pl: '18px',
              pr: '8px',
              minHeight: 22,
              fontSize: 12,
              color: ink.primary,
              borderBottom: `1px solid ${line}`,
              '&:last-of-type': { borderBottom: 'none' },
            }}
          >
            <Box
              sx={{
                position: 'absolute',
                left: 0,
                top: 0,
                bottom: 0,
                display: 'flex',
                alignItems: 'center',
              }}
            >
              <StatusMark status={h.status} size={11} />
            </Box>
            <Box
              component="span"
              title={h.name}
              sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            >
              {h.name}
            </Box>
            {GROUPS.map(g => (
              <React.Fragment key={g.id}>
                {value(h.groups[g.id], cellStatus(h.groups[g.id], nodeWarnAbove, nodeCritAbove))}
              </React.Fragment>
            ))}
            {value(h.retransmit, 'ok')}
          </Box>
        ))}
      </ScrollArea>
    </Box>
  );
}
