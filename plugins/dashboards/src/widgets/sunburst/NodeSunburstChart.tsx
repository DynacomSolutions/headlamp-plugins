/*
 * The node-first sunburst, drawn as SVG. The first ring is one arc per node, sized by the
 * capacity of the node. Inside each node the second ring is one arc per category and the third
 * ring one arc per child. The capacity that a node does not use is a free slice at the end of the
 * node, drawn as a faint crosshatch on a transparent fill, so it reads as empty and never as a
 * used slice. Every group is its own arc at its real size: no "Other" arc and no top-N cut.
 * The legend lists node, then category, with values and percent, so colour is never the only
 * encoding. Hover (or a tap, on a touch screen) shows the label and the value in the centre.
 */
import Box from '@mui/material/Box';
import ButtonBase from '@mui/material/ButtonBase';
import { useTheme } from '@mui/material/styles';
import React from 'react';
import { useElementSize } from '../promql/useElementSize';
import {
  arcPath,
  fitCentreText,
  freeKey,
  layoutNodeArcs,
  NodeArcShape,
  nodeSpan,
  SunburstNode,
} from './geometry';
import { childShade, colourAt } from './palette';
import { clip, percent, RADIUS, VIEW } from './shared';
import type { SunburstChartProps } from './SunburstChart';

/** Pattern ids must be unique on a page that holds several charts. */
let patternCounter = 0;

/** The crosshatch: two sets of thin lines at right angles, turned by 45 degrees. */
const HATCH_STEP = 3.4;
const HATCH_OPACITY = 0.42;

const arcId = (a: Pick<NodeArcShape, 'kind' | 'nodeKey' | 'categoryKey' | 'key'>): string =>
  `${a.kind}\u0000${a.nodeKey}\u0000${a.categoryKey}\u0000${a.key}`;

const free = (n: Pick<SunburstNode, 'capacity' | 'used'>): number =>
  Math.max(0, nodeSpan(n) - Math.max(0, n.used));

export function NodeSunburstChart({
  data,
  format,
  title,
  kiosk = false,
  hideLegend = false,
}: SunburstChartProps): JSX.Element {
  const theme = useTheme();
  const mode = theme.palette.mode === 'dark' ? 'dark' : 'light';
  const [active, setActive] = React.useState<string | null>(null);
  const [picked, setPicked] = React.useState<string | null>(null);
  const hatchId = React.useRef(`sb-hatch-${++patternCounter}`).current;
  const box = useElementSize<HTMLDivElement>();

  const nodes = React.useMemo(() => data.nodes ?? [], [data.nodes]);
  const arcs = React.useMemo(() => layoutNodeArcs(nodes, RADIUS), [nodes]);
  const scale = React.useMemo(() => nodes.reduce((s, n) => s + nodeSpan(n), 0), [nodes]);
  // Colours follow the category key, not its size, so a refresh never repaints a category and a
  // category has the same colour on every node.
  const colourIndex = React.useMemo(() => {
    const keys = [...new Set(nodes.flatMap(n => n.categories.map(c => c.key)))].sort();
    return new Map(keys.map((k, i) => [k, i]));
  }, [nodes]);
  const baseColour = (key: string): string => colourAt(colourIndex.get(key) ?? 0, mode);
  const nodeIndex = new Map(nodes.map((n, i) => [n.key, i]));
  const nodeTone = (key: string): number => ((nodeIndex.get(key) ?? 0) % 2 === 0 ? 0.2 : 0.34);

  // Number the children inside their category on each node, for the alternating shade.
  const siblingIndex = new Map<string, number>();
  const perCategory = new Map<string, number>();
  for (const a of arcs) {
    if (a.kind !== 'child') continue;
    const group = `${a.nodeKey}\u0000${a.categoryKey}`;
    const n = perCategory.get(group) ?? 0;
    siblingIndex.set(arcId(a), n);
    perCategory.set(group, n + 1);
  }
  const shade = (a: NodeArcShape): string =>
    a.kind === 'child'
      ? childShade(baseColour(a.categoryKey), siblingIndex.get(arcId(a)) ?? 0, mode)
      : baseColour(a.categoryKey);

  const used = nodes.reduce((s, n) => s + Math.max(0, n.used), 0);
  const capacity = Math.max(data.capacity, scale);
  const share = (v: number): number => (scale > 0 ? v / scale : 0);
  const shown = active ?? picked;
  const shownArc = shown ? arcs.find(a => arcId(a) === shown) : undefined;
  const nodeOf = (key: string): SunburstNode | undefined => nodes.find(n => n.key === key);

  const arcTitle = (a: NodeArcShape): string => {
    if (a.kind === 'node') {
      const n = nodeOf(a.nodeKey);
      const own =
        n && nodeSpan(n) > 0 ? ` (${percent(Math.max(0, n.used) / nodeSpan(n))} used)` : '';
      return `${a.label}: ${format(a.value)} of ${format(n ? nodeSpan(n) : a.value)}${own}`;
    }
    if (a.kind === 'free')
      return `${a.nodeLabel} free: ${format(a.value)} (${percent(share(a.value))})`;
    const path = a.kind === 'category' ? a.label : `${a.categoryLabel} / ${a.label}`;
    return `${a.nodeLabel} / ${path}: ${format(a.value)} (${percent(share(a.value))})`;
  };

  const summary =
    nodes.length === 0
      ? `${title}: no usage`
      : `${title}: ${format(used)} of ${format(data.capacity)} used on ${
          nodes.length
        } nodes. ${nodes.map(n => `${n.label} ${percent(share(Math.max(0, n.used)))}`).join(', ')}`;

  const surface = theme.palette.background.paper;
  const hatchColour = theme.palette.text.secondary;
  const select = (id: string) => setPicked(p => (p === id ? null : id));
  // Hover is a help for a mouse. The kiosk is a touch screen, so a tap selects instead.
  const hoverProps = (id: string) =>
    kiosk ? {} : { onMouseEnter: () => setActive(id), onMouseLeave: () => setActive(null) };
  const related = (a: NodeArcShape): boolean => {
    if (!shownArc) return true;
    if (a.nodeKey !== shownArc.nodeKey) return false;
    if (a.kind === 'node' || shownArc.kind === 'node') return true;
    if (a.kind === 'free' || shownArc.kind === 'free') return a.kind === shownArc.kind;
    return a.categoryKey === shownArc.categoryKey;
  };

  const centreLabel = shownArc ? clip(shownArc.label, 22) : title;
  const centreValue = shownArc ? format(shownArc.value) : format(used);
  const centreSub = shownArc
    ? shownArc.kind === 'node'
      ? `${percent(share(shownArc.value))} of capacity`
      : `${clip(shownArc.nodeLabel, 10)} · ${percent(share(shownArc.value))}`
    : `of ${format(data.capacity)} (${percent(capacity > 0 ? Math.min(1, used / capacity) : 0)})`;

  // The legend sits beside the ring in a wide box and under it in a narrow one. The ring never
  // takes more than 60 % of the short side, so the legend keeps room for its numbers.
  const bw = box.size.width;
  const bh = box.size.height;
  const side = bw > 0 && bh > 0 && bw / bh > 1.15;
  const legend = !hideLegend && nodes.length > 0;
  const ringSize = !legend
    ? Math.min(bw, bh)
    : side
    ? Math.min(bh, bw * 0.55)
    : Math.min(bw, bh * 0.6);
  const legendWidth = side ? bw - ringSize - 10 : bw;
  const columns = legendWidth >= 330 ? 2 : 1;
  const LINE = 15;
  const NODE_GAP = 7;

  const nodeLabelFits = (a: NodeArcShape): boolean => {
    const r = (a.inner + a.outer) / 2;
    const arcLength = (a.end - a.start) * r;
    return arcLength >= a.label.length * 4.4 + 4;
  };

  const swatch = (background: string, hatched = false): JSX.Element => (
    <Box
      component="span"
      aria-hidden
      sx={{
        width: 8,
        height: 8,
        borderRadius: '1px',
        flex: 'none',
        ...(hatched
          ? {
              border: 1,
              borderColor: 'text.disabled',
              backgroundImage: `repeating-linear-gradient(45deg, transparent 0 1.5px, ${hatchColour} 1.5px 2.2px)`,
            }
          : { bgcolor: background }),
      }}
    />
  );

  const row = (
    key: string,
    id: string,
    mark: JSX.Element,
    label: string,
    value: number,
    opts: { bold?: boolean; indent?: boolean; muted?: boolean; dataKey: string }
  ): JSX.Element => (
    <ButtonBase
      key={key}
      data-legend-row={opts.dataKey}
      onClick={() => select(id)}
      {...hoverProps(id)}
      title={`${label}: ${format(value)} (${percent(share(value))})`}
      focusRipple={false}
      disableRipple={kiosk}
      sx={{
        display: 'flex',
        width: '100%',
        alignItems: 'center',
        gap: '6px',
        height: LINE,
        pl: opts.indent ? '12px' : 0,
        fontSize: opts.bold ? 12.5 : 11.5,
        fontWeight: opts.bold ? 700 : 400,
        color: opts.muted ? 'text.secondary' : 'text.primary',
        textAlign: 'left',
        outline: 'none',
        '&.Mui-focusVisible': { outline: kiosk ? 'none' : undefined },
      }}
    >
      {mark}
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
      sx={{
        display: 'flex',
        flexDirection: side ? 'row' : 'column',
        alignItems: 'center',
        gap: 1.25,
        height: '100%',
        minHeight: 0,
        width: '100%',
      }}
    >
      <svg
        role="img"
        aria-label={summary}
        viewBox={`${-VIEW / 2} ${-VIEW / 2} ${VIEW} ${VIEW}`}
        style={{
          width: ringSize > 0 ? Math.round(ringSize) : '100%',
          height: ringSize > 0 ? Math.round(ringSize) : '100%',
          flex: 'none',
          display: 'block',
          touchAction: 'manipulation',
        }}
      >
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
              stroke={hatchColour}
              strokeOpacity={HATCH_OPACITY}
              strokeWidth={0.4}
              fill="none"
            />
          </pattern>
        </defs>
        {arcs.map(a => {
          const d = arcPath(a.inner, a.outer, a.start, a.end);
          if (!d) return null;
          const id = arcId(a);
          const dim = shown !== null && !related(a);
          const isFree = a.kind === 'free';
          const common = {
            d,
            fillRule: 'evenodd' as const,
            'data-arc': a.kind,
            'data-key': a.key,
            'data-node': a.nodeKey,
            onClick: () => select(id),
            style: { cursor: 'pointer', outline: 'none', opacity: dim ? 0.4 : 1 },
            ...hoverProps(id),
          };
          const fill = isFree
            ? `url(#${hatchId})`
            : a.kind === 'node'
            ? theme.palette.text.primary
            : shade(a);
          const style = {
            fill,
            fillOpacity: a.kind === 'node' ? nodeTone(a.nodeKey) : 1,
            stroke: isFree ? hatchColour : surface,
            strokeOpacity: isFree ? 0.3 : 1,
            strokeWidth: isFree ? 0.4 : 0.75,
          };
          const interactive = a.kind === 'node' || a.kind === 'category' || isFree;
          return interactive ? (
            <path
              key={id}
              {...common}
              {...style}
              role="button"
              tabIndex={0}
              aria-label={arcTitle(a)}
              onKeyDown={e => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  select(id);
                }
              }}
              onFocus={kiosk ? undefined : () => setActive(id)}
              onBlur={kiosk ? undefined : () => setActive(null)}
            >
              <title>{arcTitle(a)}</title>
            </path>
          ) : (
            <path key={id} {...common} {...style} role="img" aria-label={arcTitle(a)}>
              <title>{arcTitle(a)}</title>
            </path>
          );
        })}
        {arcs
          .filter(a => a.kind === 'node' && nodeLabelFits(a))
          .map(a => {
            const mid = (a.start + a.end) / 2;
            const r = (a.inner + a.outer) / 2;
            const x = r * Math.sin(mid);
            const y = -r * Math.cos(mid);
            // Turn the text with the arc, and keep it upright in the lower half.
            const deg = (mid * 180) / Math.PI;
            const turn = deg > 90 && deg < 270 ? deg + 180 : deg;
            return (
              <text
                key={`label-${a.key}`}
                data-node-label={a.key}
                x={x}
                y={y}
                transform={`rotate(${turn.toFixed(2)} ${x.toFixed(3)} ${y.toFixed(3)})`}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={6.2}
                fontWeight={600}
                fill={theme.palette.text.primary}
                style={{ pointerEvents: 'none' }}
              >
                {a.label}
              </text>
            );
          })}
        <g
          data-sunburst-centre
          style={{ pointerEvents: 'none' }}
          textAnchor="middle"
          fill={theme.palette.text.primary}
        >
          <text
            y={-14}
            fontSize={fitCentreText(centreLabel, 9.5, -17, RADIUS)}
            fill={theme.palette.text.secondary}
          >
            {centreLabel}
          </text>
          <text
            y={8}
            fontSize={fitCentreText(centreValue, 22, 3, RADIUS, true)}
            fontWeight={600}
            style={{ fontVariantNumeric: 'tabular-nums' }}
          >
            {centreValue}
          </text>
          <text
            y={22}
            fontSize={fitCentreText(centreSub, 8, 20, RADIUS)}
            fill={theme.palette.text.secondary}
          >
            {centreSub}
          </text>
        </g>
      </svg>
      {legend && (
        <Box
          component="ul"
          aria-label={`${title} nodes`}
          sx={{
            listStyle: 'none',
            m: 0,
            p: 0,
            flex: '1 1 0',
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
            const nodeId = arcId({ kind: 'node', nodeKey: n.key, categoryKey: '', key: n.key });
            const freeArcId = arcId({
              kind: 'free',
              nodeKey: n.key,
              categoryKey: '',
              key: freeKey(n.key),
            });
            return (
              <li key={n.key} data-legend-node={n.key} style={{ minWidth: 0 }}>
                {row(
                  n.key,
                  nodeId,
                  swatch(theme.palette.text.secondary),
                  n.label,
                  Math.max(0, n.used),
                  { bold: true, dataKey: n.key }
                )}
                {cats.map(c =>
                  row(
                    `${n.key}/${c.key}`,
                    arcId({ kind: 'category', nodeKey: n.key, categoryKey: c.key, key: c.key }),
                    swatch(baseColour(c.key)),
                    c.label,
                    c.value,
                    { indent: true, dataKey: `${n.key}/${c.key}` }
                  )
                )}
                {free(n) > 0 &&
                  row(`${n.key}/free`, freeArcId, swatch('transparent', true), 'Free', free(n), {
                    indent: true,
                    muted: true,
                    dataKey: freeKey(n.key),
                  })}
              </li>
            );
          })}
        </Box>
      )}
    </Box>
  );
}
