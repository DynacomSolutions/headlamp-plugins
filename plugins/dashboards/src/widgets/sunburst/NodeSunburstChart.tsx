/*
 * The node-first sunburst: one ring (see `NodeRing`) and a legend. The first ring is one arc per
 * node, sized by the capacity of the node. Inside each node the second ring is one arc per category
 * and the third ring one arc per child. The capacity that a node does not use is a free slice at the
 * end of the node, drawn as a faint crosshatch on a transparent fill, so it reads as empty and never
 * as a used slice. Every group is its own arc at its real size: no "Other" arc and no top-N cut.
 * The legend lists node, then category, with values and percent, so colour is never the only
 * encoding. Hover (or a tap, on a touch screen) shows the label and the value in the centre.
 */
import Box from '@mui/material/Box';
import ButtonBase from '@mui/material/ButtonBase';
import React from 'react';
import { useElementSize } from '../promql/useElementSize';
import { freeKey, layoutNodeArcs, nodeSpan, SunburstNode } from './geometry';
import { LegendSwatch } from './LegendSwatch';
import {
  arcId,
  arcText,
  categoryArcId,
  freeArcId,
  freeOf,
  nodeArcId,
  NodeRing,
  useNodeColours,
} from './NodeRing';
import { percent, RADIUS } from './shared';
import type { SunburstChartProps } from './SunburstChart';

const LINE = 15;
const NODE_GAP = 7;
/** The gap between the ring and the legend that sits under it, in px. */
const RING_GAP = 10;

/**
 * The height of the legend, in px, for a number of columns. The nodes fill the columns row by row.
 * A node is one line, one line for each category and one line for its free capacity.
 */
export function legendHeight(
  nodes: ReadonlyArray<SunburstNode>,
  columns: number,
  withChildren = false
): number {
  const kids = (c: SunburstNode['categories'][number]): number =>
    withChildren ? (c.children ?? []).filter(k => k.value > 0).length : 0;
  const lines = nodes.map(
    n =>
      1 +
      n.categories.filter(c => c.value > 0).reduce((s, c) => s + 1 + kids(c), 0) +
      (freeOf(n) > 0 ? 1 : 0)
  );
  let total = 0;
  let rows = 0;
  for (let i = 0; i < lines.length; i += Math.max(1, columns)) {
    total += Math.max(...lines.slice(i, i + Math.max(1, columns))) * LINE;
    rows += 1;
  }
  return total + Math.max(0, rows - 1) * NODE_GAP;
}

export function NodeSunburstChart({
  data,
  format,
  title,
  kiosk = false,
  hideLegend = false,
  unit,
  labelIcon,
  paint,
  pathSeparator,
  ringLabels = false,
  legendChildren = false,
  tooltip = false,
}: SunburstChartProps): JSX.Element {
  const [active, setActive] = React.useState<string | null>(null);
  const [picked, setPicked] = React.useState<string | null>(null);
  const box = useElementSize<HTMLDivElement>();

  const nodes = React.useMemo(() => data.nodes ?? [], [data.nodes]);
  const lists = React.useMemo(() => [nodes], [nodes]);
  const colours = useNodeColours(lists);
  const { baseColour } = colours;
  const scale = React.useMemo(() => nodes.reduce((s, n) => s + nodeSpan(n), 0), [nodes]);
  const share = (v: number): number => (scale > 0 ? v / scale : 0);
  const shown = active ?? picked;
  const free = freeOf;
  const arcs = React.useMemo(
    () => (tooltip ? layoutNodeArcs(nodes, RADIUS) : []),
    [nodes, tooltip]
  );
  const shownArc = tooltip && shown ? arcs.find(a => arcId(a) === shown) : undefined;
  const shownText = shownArc
    ? arcText(shownArc, share(shownArc.value), {
        nodes,
        format,
        unit,
        separator: pathSeparator,
      })
    : undefined;

  const select = (id: string) => setPicked(p => (p === id ? null : id));

  // The tooltip of the shown arc: its path and its count. It follows the pointer. A tap on a touch
  // screen, or the keyboard, has no pointer, so it sits at the top. The pointer is a ref, so a
  // move never draws the chart again.
  const pointer = React.useRef<{ x: number; y: number } | null>(null);
  const tip = React.useRef<HTMLDivElement | null>(null);
  const placeTip = (el: HTMLDivElement | null): void => {
    tip.current = el;
    if (!el) return;
    const p = pointer.current;
    if (!p) {
      el.style.left = '50%';
      el.style.top = '4px';
      el.style.transform = 'translateX(-50%)';
      return;
    }
    const w = box.size.width;
    const h = box.size.height;
    el.style.left = `${Math.round(p.x)}px`;
    el.style.top = `${Math.round(p.y)}px`;
    el.style.transform = `translate(${p.x > w / 2 ? 'calc(-100% - 12px)' : '14px'}, ${
      p.y > h * 0.75 ? 'calc(-100% - 12px)' : '14px'
    })`;
  };
  // Hover is a help for a mouse. The kiosk is a touch screen, so a tap selects instead.
  const hoverProps = (id: string) =>
    kiosk ? {} : { onMouseEnter: () => setActive(id), onMouseLeave: () => setActive(null) };

  // The legend sits beside the ring in a wide box and under it in a narrow one. The ring never
  // takes more than 60 % of the short side, so the legend keeps room for its numbers.
  const bw = box.size.width;
  const bh = box.size.height;
  const side = bw > 0 && bh > 0 && bw / bh > 1.15;
  const legend = !hideLegend && nodes.length > 0;
  // Under the ring the legend is as tall as its rows need. The ring takes all the rest, so a tall
  // box shows a big ring and a tight legend, never a small ring with a gap under it.
  const underColumns = bw >= 330 ? 2 : 1;
  const underHeight = legend && !side ? legendHeight(nodes, underColumns, legendChildren) : 0;
  const ringSize = !legend
    ? Math.min(bw, bh)
    : side
    ? Math.min(bh, bw * 0.55)
    : Math.min(bw, Math.max(bh * 0.6, bh - underHeight - RING_GAP));
  const legendWidth = side ? bw - ringSize - 10 : bw;
  const columns = legendWidth >= 330 ? 2 : 1;

  const row = (
    key: string,
    id: string,
    mark: JSX.Element,
    label: string,
    value: number,
    opts: {
      bold?: boolean;
      indent?: number;
      muted?: boolean;
      dataKey: string;
      kind?: 'node' | 'category' | 'child';
    }
  ): JSX.Element => (
    <ButtonBase
      key={key}
      data-legend-row={opts.dataKey}
      onClick={() => select(id)}
      {...hoverProps(id)} // dashboard-links: allow hover handlers only
      title={tooltip ? undefined : `${label}: ${format(value)} (${percent(share(value))})`}
      focusRipple={false}
      disableRipple={kiosk}
      sx={{
        display: 'flex',
        width: '100%',
        alignItems: 'center',
        gap: '6px',
        height: LINE,
        pl: opts.indent ? `${opts.indent}px` : 0,
        fontSize: opts.bold ? 12.5 : 11.5,
        fontWeight: opts.bold ? 700 : 400,
        color: opts.muted ? 'text.secondary' : 'text.primary',
        textAlign: 'left',
        outline: 'none',
        '&.Mui-focusVisible': { outline: kiosk ? 'none' : undefined },
      }}
    >
      {mark}
      {opts.kind ? labelIcon?.(label, 12, undefined, opts.kind) : labelIcon?.(label, 12)}
      <Box
        component="span"
        sx={{
          flex: 1,
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {label}
      </Box>
      <Box component="span" sx={{ whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
        {format(value)}
      </Box>
      <Box
        component="span"
        sx={{
          color: 'text.secondary',
          fontWeight: 400,
          minWidth: 34,
          textAlign: 'right',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {percent(share(value))}
      </Box>
    </ButtonBase>
  );

  return (
    <Box
      ref={box.ref}
      data-sunburst
      data-sunburst-nodes
      onMouseMove={
        tooltip && !kiosk
          ? e => {
              const r = e.currentTarget.getBoundingClientRect();
              pointer.current = { x: e.clientX - r.left, y: e.clientY - r.top };
              if (tip.current) placeTip(tip.current);
            }
          : undefined
      }
      onMouseLeave={
        tooltip
          ? () => {
              pointer.current = null;
            }
          : undefined
      }
      sx={{
        position: 'relative',
        display: 'flex',
        flexDirection: side ? 'row' : 'column',
        alignItems: 'center',
        // Under the ring, the ring and the legend sit together in the middle, never apart.
        justifyContent: side ? undefined : 'center',
        gap: 1.25,
        height: '100%',
        minHeight: 0,
        width: '100%',
      }}
    >
      {tooltip && shownArc && (
        <Box
          ref={placeTip}
          role="tooltip"
          data-sunburst-tooltip
          sx={{
            position: 'absolute',
            zIndex: 2,
            pointerEvents: 'none',
            maxWidth: 'min(92%, 420px)',
            px: 1,
            py: 0.5,
            borderRadius: 0.5,
            bgcolor: 'background.paper',
            color: 'text.primary',
            border: 1,
            borderColor: 'divider',
            boxShadow: 3,
            fontSize: 12,
            lineHeight: '16px',
          }}
        >
          <Box component="div" sx={{ fontWeight: 700, overflowWrap: 'anywhere' }}>
            {shownText?.path}
          </Box>
          <Box component="div" sx={{ color: 'text.secondary' }}>
            {shownText?.figure}
            {shownText?.note ? `, ${shownText.note}` : ''}
          </Box>
        </Box>
      )}
      <NodeRing
        data={data}
        format={format}
        title={title}
        colours={colours}
        kiosk={kiosk}
        shown={shown}
        onActive={setActive}
        onPick={select}
        size={ringSize}
        unit={unit}
        labelIcon={labelIcon}
        paint={paint}
        pathSeparator={pathSeparator}
        ringLabels={ringLabels}
        customTooltip={tooltip}
      />
      {legend && (
        <Box
          component="ul"
          aria-label={`${title} nodes`}
          sx={{
            listStyle: 'none',
            m: 0,
            p: 0,
            flex: side ? '1 1 0' : '0 1 auto',
            minWidth: 0,
            minHeight: 0,
            width: '100%',
            // A row box centres its children, so stretch the list to the box height, then it scrolls.
            alignSelf: 'stretch',
            overflowY: 'auto',
            overflowX: 'hidden',
            display: 'grid',
            gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
            alignContent: 'start',
            gap: `${NODE_GAP}px 16px`,
          }}
        >
          {nodes.map(n => {
            const cats = n.categories.filter(c => c.value > 0).sort((a, b) => b.value - a.value);
            const nodeId = nodeArcId(n.key);
            const nodePaint = paint?.({
              kind: 'node',
              nodeKey: n.key,
              categoryKey: '',
              key: n.key,
            });
            return (
              <li key={n.key} data-legend-node={n.key} style={{ minWidth: 0 }}>
                {row(
                  n.key,
                  nodeId,
                  nodePaint ? (
                    <LegendSwatch colour={nodePaint.fill} />
                  ) : (
                    <LegendSwatch tone={colours.nodeTone(n.key)} />
                  ),
                  n.label,
                  Math.max(0, n.used),
                  { bold: true, dataKey: n.key, kind: 'node' }
                )}
                {cats.map(c => {
                  const catPaint = paint?.({
                    kind: 'category',
                    nodeKey: n.key,
                    categoryKey: c.key,
                    key: c.key,
                  });
                  const kids = legendChildren
                    ? [...(c.children ?? [])]
                        .filter(k => k.value > 0)
                        .sort((a, b) => b.value - a.value)
                    : [];
                  return (
                    <React.Fragment key={`${n.key}/${c.key}`}>
                      {row(
                        `${n.key}/${c.key}`,
                        categoryArcId(n.key, c.key),
                        <LegendSwatch colour={catPaint?.fill ?? baseColour(c.key)} />,
                        c.label,
                        c.value,
                        { indent: 12, dataKey: `${n.key}/${c.key}`, kind: 'category' }
                      )}
                      {kids.map(k => {
                        const kidPaint = paint?.({
                          kind: 'child',
                          nodeKey: n.key,
                          categoryKey: c.key,
                          key: k.key,
                        });
                        return row(
                          `${n.key}/${c.key}/${k.key}`,
                          arcId({ kind: 'child', nodeKey: n.key, categoryKey: c.key, key: k.key }),
                          <LegendSwatch colour={kidPaint?.fill ?? baseColour(c.key)} />,
                          k.label,
                          k.value,
                          {
                            indent: 24,
                            muted: true,
                            dataKey: `${n.key}/${c.key}/${k.key}`,
                            kind: 'child',
                          }
                        );
                      })}
                    </React.Fragment>
                  );
                })}
                {free(n) > 0 &&
                  row(
                    `${n.key}/free`,
                    freeArcId(n.key),
                    <LegendSwatch hatched />,
                    'Free',
                    free(n),
                    {
                      indent: 12,
                      muted: true,
                      dataKey: freeKey(n.key),
                    }
                  )}
              </li>
            );
          })}
        </Box>
      )}
    </Box>
  );
}
