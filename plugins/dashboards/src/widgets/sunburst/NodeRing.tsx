/*
 * One node-first ring, drawn as SVG: the node ring, the category ring, the child ring and the free
 * crosshatch of each node. It holds no state. The parent owns the highlight, so one legend can
 * drive several rings (see `UsagePair`), and the parent owns the colours, so the same node and the
 * same category have the same colour in every ring. Every group is its own arc at its real size:
 * no "Other" arc and no top-N cut.
 */
import { useTheme } from '@mui/material/styles';
import React from 'react';
import {
  arcPath,
  fitCentreText,
  freeKey,
  layoutNodeArcs,
  NodeArcShape,
  nodeSpan,
  SunburstData,
  SunburstNode,
} from './geometry';
import { childShade, colourAt, Mode } from './palette';
import { clip, percent, RADIUS, VIEW } from './shared';

/** Pattern ids must be unique on a page that holds several charts. */
let patternCounter = 0;

/** The crosshatch: two sets of thin lines at right angles, turned by 45 degrees. */
const HATCH_STEP = 3.4;
const HATCH_OPACITY = 0.42;

export const arcId = (a: Pick<NodeArcShape, 'kind' | 'nodeKey' | 'categoryKey' | 'key'>): string =>
  `${a.kind}\u0000${a.nodeKey}\u0000${a.categoryKey}\u0000${a.key}`;

export const nodeArcId = (nodeKey: string): string =>
  arcId({ kind: 'node', nodeKey, categoryKey: '', key: nodeKey });
export const categoryArcId = (nodeKey: string, categoryKey: string): string =>
  arcId({ kind: 'category', nodeKey, categoryKey, key: categoryKey });
export const freeArcId = (nodeKey: string): string =>
  arcId({ kind: 'free', nodeKey, categoryKey: '', key: freeKey(nodeKey) });

/** The id of the category that holds a child id. Other ids stay as they are. */
export const categoryOf = (id: string): string => {
  const [kind, nodeKey, categoryKey] = id.split('\u0000');
  return kind === 'child' ? categoryArcId(nodeKey, categoryKey) : id;
};

/** The free capacity of a node. */
export const freeOf = (n: Pick<SunburstNode, 'capacity' | 'used'>): number =>
  Math.max(0, nodeSpan(n) - Math.max(0, n.used));

export interface NodeColours {
  baseColour: (categoryKey: string) => string;
  /** The opacity of the node arc. Two tones alternate, so neighbours stay apart. */
  nodeTone: (nodeKey: string) => number;
  mode: Mode;
}

/**
 * Colours that follow the key, not the size or the position in one chart. The categories are
 * sorted over every chart given, so a refresh never repaints a category, a category has the same
 * colour on every node and in every chart. A node keeps its tone by its place in the first list
 * that names it.
 */
export function useNodeColours(lists: ReadonlyArray<ReadonlyArray<SunburstNode>>): NodeColours {
  const theme = useTheme();
  const mode: Mode = theme.palette.mode === 'dark' ? 'dark' : 'light';
  const signature = lists
    .map(l => l.map(n => `${n.key}:${n.categories.map(c => c.key).join(',')}`).join('|'))
    .join('#');
  return React.useMemo(() => {
    const categories = [
      ...new Set(lists.flatMap(l => l.flatMap(n => n.categories.map(c => c.key)))),
    ].sort();
    const colourIndex = new Map(categories.map((k, i) => [k, i]));
    const nodeKeys = [...new Set(lists.flatMap(l => l.map(n => n.key)))];
    const nodeIndex = new Map(nodeKeys.map((k, i) => [k, i]));
    return {
      mode,
      baseColour: (key: string) => colourAt(colourIndex.get(key) ?? 0, mode),
      nodeTone: (key: string) => ((nodeIndex.get(key) ?? 0) % 2 === 0 ? 0.2 : 0.34),
    };
    // `signature` covers every key that matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, mode]);
}

export interface NodeRingProps {
  data: SunburstData;
  format: (value: number) => string;
  /** The title in the centre when nothing is shown, for example `CPU`. */
  title: string;
  colours: NodeColours;
  kiosk?: boolean;
  /** The id of the arc to show, or null. A child id that this ring has not falls back to its category. */
  shown: string | null;
  onActive: (id: string | null) => void;
  onPick: (id: string) => void;
  /** The side of the square in px. 0 fills the box. */
  size?: number;
}

export function NodeRing({
  data,
  format,
  title,
  colours,
  kiosk = false,
  shown,
  onActive,
  onPick,
  size = 0,
}: NodeRingProps): JSX.Element {
  const theme = useTheme();
  const hatchId = React.useRef(`sb-hatch-${++patternCounter}`).current;
  const { baseColour, mode } = colours;

  const nodes = React.useMemo(() => data.nodes ?? [], [data.nodes]);
  const arcs = React.useMemo(() => layoutNodeArcs(nodes, RADIUS), [nodes]);
  const scale = React.useMemo(() => nodes.reduce((s, n) => s + nodeSpan(n), 0), [nodes]);

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
  const shownArc = shown
    ? arcs.find(a => arcId(a) === shown) ?? arcs.find(a => arcId(a) === categoryOf(shown))
    : undefined;
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
  // Hover is a help for a mouse. The kiosk is a touch screen, so a tap selects instead.
  const hoverProps = (id: string) =>
    kiosk ? {} : { onMouseEnter: () => onActive(id), onMouseLeave: () => onActive(null) };
  const related = (a: NodeArcShape): boolean => {
    if (!shown) return true;
    // The shown arc is not in this ring: nothing here is related.
    if (!shownArc) return false;
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

  const nodeLabelFits = (a: NodeArcShape): boolean => {
    const r = (a.inner + a.outer) / 2;
    const arcLength = (a.end - a.start) * r;
    return arcLength >= a.label.length * 4.4 + 4;
  };

  return (
    <svg
      role="img"
      aria-label={summary}
      data-ring={title}
      viewBox={`${-VIEW / 2} ${-VIEW / 2} ${VIEW} ${VIEW}`}
      style={{
        width: size > 0 ? Math.round(size) : '100%',
        height: size > 0 ? Math.round(size) : '100%',
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
          'data-dim': dim ? 'true' : undefined,
          onClick: () => onPick(id),
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
          fillOpacity: a.kind === 'node' ? colours.nodeTone(a.nodeKey) : 1,
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
                onPick(id);
              }
            }}
            onFocus={kiosk ? undefined : () => onActive(id)}
            onBlur={kiosk ? undefined : () => onActive(null)}
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
  );
}
