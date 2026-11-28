/*
 * Two node-first sunbursts (for example CPU and memory) with ONE compact shared legend. The same
 * node and the same category have the same colour in both rings. The legend has a colour key of the
 * categories once at the top, then one line for each node: the name, then the used and total value of
 * each ring with a thin bar split by category in the colours of the rings. A hover on a bar segment
 * names the category and its value, and it highlights the same group in both rings. The legend stays
 * in place and scrolls inside itself when it is long: there is no "+N more" row and no "Other"
 * group. On a touch screen (the kiosk) a tap selects instead.
 *
 * The layout follows the width and the height of the widget itself (a ResizeObserver, not the
 * window). A narrow widget always stacks the rings, CPU above memory, each nearly as wide as the
 * widget, with the legend below. A wide widget puts the legend on the right, or below, whichever
 * gives the biggest rings.
 */
import Box from '@mui/material/Box';
import ButtonBase from '@mui/material/ButtonBase';
import Tooltip from '@mui/material/Tooltip';
import React from 'react';
import { useElementSize } from '../promql/useElementSize';
import { SunburstData } from './geometry';
import { LegendSwatch } from './LegendSwatch';
import { categoryOf, NodeRing, useNodeColours } from './NodeRing';
import {
  FREE_SEGMENT,
  inOrder,
  NODE_LINE,
  PairBar,
  pairLayout,
  pairLegend,
  pairOrder,
  shortUsage,
} from './pairModel';
import { SunburstChart } from './SunburstChart';

export interface PairRing {
  data: SunburstData;
  /** Formats a value in the unit of the ring, for example `5.2 GiB` or `1.20 cores`. */
  format: (value: number) => string;
  /** The title of the ring, for example `CPU`. It heads its bar column. */
  title: string;
}

export interface UsagePairProps {
  first: PairRing;
  second: PairRing;
  kiosk?: boolean;
}

/** Rows of one grid, so the head and every node line line up. */
const GRID = 'minmax(0, 0.8fr) minmax(0, 1.5fr) minmax(0, 1.5fr)';
const BAR_HEIGHT = 6;

export function UsagePair({ first, second, kiosk = false }: UsagePairProps): JSX.Element {
  const [active, setActive] = React.useState<string | null>(null);
  const [picked, setPicked] = React.useState<string | null>(null);
  const box = useElementSize<HTMLDivElement>();
  // One node order for both rings and the legend.
  const ordered = React.useMemo(() => {
    const order = pairOrder(first.data, second.data);
    return [inOrder(first.data, order), inOrder(second.data, order)] as const;
  }, [first.data, second.data]);
  const lists = React.useMemo(() => [ordered[0].nodes ?? [], ordered[1].nodes ?? []], [ordered]);
  const colours = useNodeColours(lists);
  const legend = React.useMemo(
    () => pairLegend(first.data, second.data),
    [first.data, second.data]
  );
  const shown = active ?? picked;
  const shownRow = shown ? categoryOf(shown) : null;
  const select = (id: string) => setPicked(p => (p === id ? null : id));
  const hover = (id: string) =>
    kiosk ? {} : { onMouseEnter: () => setActive(id), onMouseLeave: () => setActive(null) };
  const rings = [first, second];

  const layout = pairLayout(box.size.width, box.size.height, legend.nodes.length);
  const right = layout.mode === 'right';
  const stacked = layout.mode === 'below-stack';

  const bar = (
    b: PairBar | undefined,
    ring: PairRing,
    nodeLabel: string,
    nodeId: string
  ): JSX.Element => {
    if (!b)
      return (
        <Box component="span" sx={{ color: 'text.disabled', fontSize: 11 }}>
          –
        </Box>
      );
    const text = `${ring.title} on ${nodeLabel}: ${shortUsage(b.used, b.total, ring.format)}`;
    return (
      <Box sx={{ minWidth: 0 }}>
        <Box
          component="span"
          data-legend-value
          sx={{
            display: 'block',
            fontSize: 11,
            lineHeight: '13px',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {shortUsage(b.used, b.total, ring.format)}
        </Box>
        <Box
          role="img"
          aria-label={`${text}. ${b.segments
            .map(s => `${s.label} ${ring.format(s.value)}`)
            .join(', ')}`}
          data-legend-bar={ring.title}
          sx={{
            display: 'flex',
            height: BAR_HEIGHT,
            mt: '3px',
            borderRadius: '1px',
            overflow: 'hidden',
            bgcolor: 'action.hover',
          }}
        >
          {b.segments.map(s => {
            const tip = `${nodeLabel} / ${s.label}: ${ring.format(s.value)}`;
            return (
              <Tooltip key={s.key} title={kiosk ? '' : tip} arrow placement="top" enterDelay={80}>
                <ButtonBase
                  tabIndex={-1}
                  data-legend-seg={s.key}
                  data-lit={shownRow === s.id ? 'true' : undefined}
                  aria-label={tip}
                  onClick={() => select(s.id)}
                  {...hover(s.id)} // dashboard-links: allow hover handlers only
                  focusRipple={false}
                  disableRipple
                  sx={theme => ({
                    flex: `${s.value} 1 0`,
                    minWidth: '1px',
                    height: '100%',
                    display: 'block',
                    opacity:
                      shownRow === null || shownRow === s.id || shownRow === nodeId ? 1 : 0.4,
                    ...(s.free
                      ? {
                          backgroundImage: `repeating-linear-gradient(45deg, transparent 0 1.5px, ${theme.palette.text.secondary} 1.5px 2.2px)`,
                        }
                      : { bgcolor: colours.baseColour(s.key) }),
                  })}
                />
              </Tooltip>
            );
          })}
        </Box>
      </Box>
    );
  };

  const node = (n: (typeof legend.nodes)[number]): JSX.Element => {
    const lit = shownRow === n.id;
    return (
      <Box
        component="li"
        key={n.key}
        data-legend-node={n.key}
        sx={{
          display: 'grid',
          gridTemplateColumns: GRID,
          alignItems: 'center',
          columnGap: '8px',
          minHeight: NODE_LINE - 4,
          minWidth: 0,
        }}
      >
        <ButtonBase
          data-legend-row={n.key}
          data-lit={lit ? 'true' : undefined}
          onClick={() => select(n.id)}
          {...hover(n.id)} // dashboard-links: allow hover handlers only
          title={n.label}
          focusRipple={false}
          disableRipple={kiosk}
          sx={{
            justifyContent: 'flex-start',
            minWidth: 0,
            fontSize: 11.5,
            fontWeight: 700,
            textAlign: 'left',
            borderRadius: '2px',
            outline: 'none',
            bgcolor: lit ? 'action.selected' : 'transparent',
            '&.Mui-focusVisible': { outline: kiosk ? 'none' : undefined },
          }}
        >
          <Box
            component="span"
            sx={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          >
            {n.label}
          </Box>
        </ButtonBase>
        {rings.map((r, i) => (
          <Box key={r.title} data-legend-cell={i} sx={{ minWidth: 0 }}>
            {bar(n.bars[i], r, n.label, n.id)}
          </Box>
        ))}
      </Box>
    );
  };

  const fallback = legend.nodes.length === 0;
  if (fallback) {
    // An agent that sends no per-node data: two category-first charts, each with its own legend.
    return (
      <Box
        data-usage-pair
        sx={{ display: 'flex', gap: 1.5, height: '100%', minHeight: 0, width: '100%' }}
      >
        {[first, second].map(r => (
          <Box key={r.title} sx={{ flex: '1 1 0', minWidth: 0, minHeight: 0 }}>
            <SunburstChart data={r.data} title={r.title} format={r.format} kiosk={kiosk} />
          </Box>
        ))}
      </Box>
    );
  }

  return (
    <Box
      ref={box.ref}
      data-usage-pair
      data-layout={layout.mode}
      sx={{
        display: 'flex',
        flexDirection: right ? 'row' : 'column',
        alignItems: 'center',
        gap: 1,
        height: '100%',
        minHeight: 0,
        width: '100%',
      }}
    >
      <Box
        sx={{
          display: 'flex',
          flexDirection: stacked ? 'column' : 'row',
          gap: '4px',
          flex: 'none',
          alignItems: 'center',
        }}
      >
        {rings.map((r, i) => (
          <NodeRing
            key={r.title}
            data={ordered[i]}
            format={r.format}
            title={r.title}
            colours={colours}
            kiosk={kiosk}
            shown={shown}
            onActive={setActive}
            onPick={select}
            size={layout.ring}
          />
        ))}
      </Box>
      <Box
        data-usage-legend
        sx={{
          flex: '1 1 0',
          minWidth: 0,
          minHeight: 0,
          width: '100%',
          alignSelf: 'stretch',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <Box
          data-legend-key
          sx={{
            display: 'flex',
            flexWrap: 'wrap',
            columnGap: '10px',
            rowGap: '2px',
            flex: 'none',
            fontSize: 11,
            pb: '4px',
          }}
        >
          {legend.categories.map(c => (
            <Box
              key={c.key}
              component="span"
              data-legend-chip={c.key}
              sx={{ display: 'inline-flex', alignItems: 'center', gap: '4px', minWidth: 0 }}
            >
              <LegendSwatch colour={colours.baseColour(c.key)} />
              {c.label}
            </Box>
          ))}
          {legend.hasFree && (
            <Box
              component="span"
              data-legend-chip={FREE_SEGMENT}
              sx={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '4px',
                color: 'text.secondary',
              }}
            >
              <LegendSwatch hatched />
              Free
            </Box>
          )}
        </Box>
        <Box
          data-legend-head
          sx={{
            display: 'grid',
            gridTemplateColumns: GRID,
            columnGap: '8px',
            flex: 'none',
            fontSize: 11,
            fontWeight: 700,
            color: 'text.secondary',
            pb: '3px',
            mb: '3px',
            borderBottom: 1,
            borderColor: 'divider',
          }}
        >
          <span>Node</span>
          {rings.map(r => (
            <span key={r.title}>{r.title}</span>
          ))}
        </Box>
        <Box
          component="ul"
          aria-label={`${first.title} and ${second.title} by node`}
          sx={{
            listStyle: 'none',
            m: 0,
            p: 0,
            flex: '1 1 0',
            minHeight: 0,
            overflowY: 'auto',
            overflowX: 'hidden',
            display: 'flex',
            flexDirection: 'column',
            gap: '4px',
          }}
        >
          {legend.nodes.map(node)}
        </Box>
      </Box>
    </Box>
  );
}
