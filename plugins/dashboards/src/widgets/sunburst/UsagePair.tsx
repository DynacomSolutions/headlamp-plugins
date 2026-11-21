/*
 * Two node-first sunbursts side by side (for example CPU and memory) with ONE shared legend. The
 * same node and the same category have the same colour in both rings. The legend lists node, then
 * category, then the free capacity of the node, with one value column for each ring, so the two
 * rings read against each other. The legend stays in place and scrolls inside itself when it is
 * long: there is no "+N more" row and no "Other" group. A hover on a legend row (or on an arc)
 * highlights the same group in both rings. On a touch screen (the kiosk) a tap selects instead.
 */
import Box from '@mui/material/Box';
import ButtonBase from '@mui/material/ButtonBase';
import React from 'react';
import { useElementSize } from '../promql/useElementSize';
import { SunburstData } from './geometry';
import { LegendSwatch } from './LegendSwatch';
import { categoryOf, NodeRing, useNodeColours } from './NodeRing';
import { pairNodes, PairRow } from './pairModel';
import { SunburstChart } from './SunburstChart';

export interface PairRing {
  data: SunburstData;
  /** Formats a value in the unit of the ring, for example `5.2 GiB` or `1.20 cores`. */
  format: (value: number) => string;
  /** The title of the ring, for example `CPU`. It heads its value column. */
  title: string;
}

export interface UsagePairProps {
  first: PairRing;
  second: PairRing;
  kiosk?: boolean;
}

const LEGEND_MIN = 340;
const VALUE_COL = 72;
const LINE = 15;
/** Rows of one grid, so the head and every row line up. */
const GRID = `8px minmax(0, 1fr) ${VALUE_COL}px ${VALUE_COL}px`;

export function UsagePair({ first, second, kiosk = false }: UsagePairProps): JSX.Element {
  const [active, setActive] = React.useState<string | null>(null);
  const [picked, setPicked] = React.useState<string | null>(null);
  const box = useElementSize<HTMLDivElement>();
  const nodesA = first.data.nodes;
  const nodesB = second.data.nodes;
  const lists = React.useMemo(() => [nodesA ?? [], nodesB ?? []], [nodesA, nodesB]);
  const colours = useNodeColours(lists);
  const nodes = React.useMemo(() => pairNodes(first.data, second.data), [first.data, second.data]);
  const shown = active ?? picked;
  const shownRow = shown ? categoryOf(shown) : null;
  const select = (id: string) => setPicked(p => (p === id ? null : id));
  const hover = (id: string) =>
    kiosk ? {} : { onMouseEnter: () => setActive(id), onMouseLeave: () => setActive(null) };

  const bw = box.size.width;
  const bh = box.size.height;
  const wide = bw === 0 || bw >= 560;
  const ringSize = wide
    ? Math.max(0, Math.min(bh, (bw - LEGEND_MIN - 24) / 2))
    : Math.max(0, Math.min(bh * 0.5, (bw - 8) / 2));

  const row = (r: PairRow, nodeKey: string): JSX.Element => {
    const formats = [first.format, second.format];
    const titles = [first.title, second.title];
    const lit = shownRow === r.id;
    const tip = `${r.label}: ${r.values
      .map((v, i) => `${titles[i]} ${v === undefined ? 'none' : formats[i](v)}`)
      .join(', ')}`;
    return (
      <ButtonBase
        key={r.key}
        data-legend-row={r.key}
        data-lit={lit ? 'true' : undefined}
        onClick={() => select(r.id)}
        {...hover(r.id)}
        title={tip}
        focusRipple={false}
        disableRipple={kiosk}
        sx={{
          display: 'grid',
          gridTemplateColumns: GRID,
          alignItems: 'center',
          columnGap: '6px',
          width: '100%',
          height: LINE,
          pl: r.kind === 'node' ? 0 : '12px',
          fontSize: 11.5,
          fontWeight: r.kind === 'node' ? 700 : 400,
          color: r.kind === 'free' ? 'text.secondary' : 'text.primary',
          textAlign: 'left',
          outline: 'none',
          borderRadius: '2px',
          bgcolor: lit ? 'action.selected' : 'transparent',
          '&.Mui-focusVisible': { outline: kiosk ? 'none' : undefined },
        }}
      >
        {r.kind === 'node' ? (
          <LegendSwatch tone={colours.nodeTone(nodeKey)} />
        ) : r.kind === 'free' ? (
          <LegendSwatch hatched />
        ) : (
          <LegendSwatch colour={colours.baseColour(r.categoryKey ?? '')} />
        )}
        <Box
          component="span"
          sx={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
          {r.label}
        </Box>
        {r.values.map((v, i) => (
          <Box
            key={i}
            component="span"
            data-legend-value={i}
            sx={{
              whiteSpace: 'nowrap',
              textAlign: 'right',
              fontWeight: 400,
              fontSize: 11.5,
              fontVariantNumeric: 'tabular-nums',
              color: v === undefined ? 'text.disabled' : undefined,
            }}
          >
            {v === undefined ? '–' : formats[i](v)}
          </Box>
        ))}
      </ButtonBase>
    );
  };

  const fallback = nodes.length === 0;
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
      sx={{
        display: 'flex',
        flexDirection: wide ? 'row' : 'column',
        alignItems: 'center',
        gap: wide ? 1.5 : 1,
        height: '100%',
        minHeight: 0,
        width: '100%',
      }}
    >
      <Box sx={{ display: 'flex', gap: '4px', flex: 'none', alignItems: 'center' }}>
        {[first, second].map(r => (
          <NodeRing
            key={r.title}
            data={r.data}
            format={r.format}
            title={r.title}
            colours={colours}
            kiosk={kiosk}
            shown={shown}
            onActive={setActive}
            onPick={select}
            size={ringSize}
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
          data-legend-head
          sx={{
            display: 'grid',
            gridTemplateColumns: GRID,
            columnGap: '6px',
            flex: 'none',
            fontSize: 11.5,
            fontWeight: 700,
            color: 'text.secondary',
            pb: '3px',
            mb: '3px',
            borderBottom: 1,
            borderColor: 'divider',
          }}
        >
          <span />
          <span>Node</span>
          <Box component="span" sx={{ textAlign: 'right' }}>
            {first.title}
          </Box>
          <Box component="span" sx={{ textAlign: 'right' }}>
            {second.title}
          </Box>
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
            gap: '7px',
          }}
        >
          {nodes.map(n => (
            <li key={n.key} data-legend-node={n.key} style={{ minWidth: 0 }}>
              {n.rows.map(r => row(r, n.key))}
            </li>
          ))}
        </Box>
      </Box>
    </Box>
  );
}
