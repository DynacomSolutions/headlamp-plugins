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
  NodeArcKind,
  NodeArcShape,
  nodeSpan,
  SunburstData,
  SunburstNode,
} from './geometry';
import { childShade, colourAt, Mode } from './palette';
import { clip, percent, RADIUS, VIEW } from './shared';

/** Pattern ids must be unique on a page that holds several charts. */
let patternCounter = 0;

/** The side of a logo before a node label in the ring, in viewBox units. */
const ICON = 7;
/** The font size of a pool name and of an identity or provider name in the ring, in viewBox units. */
const NODE_FONT = 6.2;
const RING_FONT = 5.4;
/** The width of a glyph as a share of the font size, and the longest text on one arc. */
const GLYPH_SHARE = 0.58;
const MAX_TEXT = 56;

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

/** What names an arc for a paint function: its kind, its node, its category and its own key. */
export interface ArcRef {
  kind: NodeArcKind;
  nodeKey: string;
  categoryKey: string;
  key: string;
}

/** The fill of an arc and the text colour (`ink`) that reads on it. */
export interface ArcPaint {
  fill: string;
  ink: string;
}

/** What a ring needs to word the text of an arc. */
export interface ArcTextContext {
  nodes: ReadonlyArray<SunburstNode>;
  format: (value: number) => string;
  unit?: string;
  /** The text between the parts of a path. Default ` / `. */
  separator?: string;
}

/**
 * The text of an arc, for its tooltip and its screen reader label. `path` is the names from the node
 * to the arc, `figure` is the value with its share and `note` is the detail of the data, if any.
 */
export function arcText(
  a: NodeArcShape,
  share: number,
  ctx: ArcTextContext
): { path: string; figure: string; note: string; text: string } {
  const { nodes, format, separator = ' / ' } = ctx;
  // A unit such as "agents" is plural. One agent is "1 agent".
  const unit = ctx.unit && a.value === 1 ? ctx.unit.replace(/s$/, '') : ctx.unit;
  const n = nodes.find(x => x.key === a.nodeKey);
  let path = a.label;
  let figure = `${format(a.value)} (${percent(share)})`;
  if (a.kind === 'node' && unit) figure = `${format(a.value)} ${unit} (${percent(share)})`;
  else if (a.kind === 'node') {
    const own = n && nodeSpan(n) > 0 ? ` (${percent(Math.max(0, n.used) / nodeSpan(n))} used)` : '';
    figure = `${format(a.value)} of ${format(n ? nodeSpan(n) : a.value)}${own}`;
  } else if (a.kind === 'free') path = `${a.nodeLabel} free`;
  else if (a.kind === 'category') path = [a.nodeLabel, a.label].join(separator);
  else path = [a.nodeLabel, a.categoryLabel, a.label].join(separator);
  if (a.kind === 'free') figure = `${format(a.value)} (${percent(share)})`;
  if (a.kind === 'category' || a.kind === 'child') {
    if (unit) figure = `${format(a.value)} ${unit} (${percent(share)})`;
  }
  const note = a.kind === 'category' || a.kind === 'child' ? a.detail ?? '' : '';
  const text = `${path}: ${figure}${note ? `, ${note}` : ''}`;
  return { path, figure, note, text };
}

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
  /** What the values count, for example `agents`. A count has no capacity to fill. */
  unit?: string;
  /** A small logo before a node label in the ring, or null (see `SunburstChartProps`). */
  labelIcon?: (
    label: string,
    size: number,
    at?: { x: number; y: number },
    kind?: ArcRef['kind']
  ) => JSX.Element | null;
  /** The fill and the ink of an arc. An arc that it gives nothing for keeps the default colours. */
  paint?: (arc: ArcRef) => ArcPaint | undefined;
  /** The text between the parts of a path in an arc label. Default ` / `. */
  pathSeparator?: string;
  /** Name the identity and the provider arcs on the ring, where the name fits. */
  ringLabels?: boolean;
  /** The ring draws no `<title>` of its own, because the parent shows a tooltip. */
  customTooltip?: boolean;
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
  unit,
  labelIcon,
  paint,
  pathSeparator,
  ringLabels = false,
  customTooltip = false,
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

  const textContext: ArcTextContext = { nodes, format, unit, separator: pathSeparator };
  const arcTitle = (a: NodeArcShape): string => arcText(a, share(a.value), textContext).text;

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
      ? `${percent(share(shownArc.value))} of ${unit ?? 'capacity'}`
      : `${clip(shownArc.nodeLabel, 10)} · ${percent(share(shownArc.value))}`
    : unit
    ? unit
    : `of ${format(data.capacity)} (${percent(capacity > 0 ? Math.min(1, used / capacity) : 0)})`;

  /**
   * What an arc shows on the ring. Without `ringLabels` only a node name shows, whole or not at all. With `ringLabels`, a
   * node, identity or provider name that is too long for its arc is cut with an ellipsis, down to 4
   * letters, and a provider arc that fits only its logo shows the logo.
   */
  const ringLabel = (a: NodeArcShape): { text: string; icon: boolean } | null => {
    const kind = a.kind === 'node' || a.kind === 'category' || a.kind === 'child' ? a.kind : null;
    if (!kind || (kind !== 'node' && !ringLabels)) return null;
    const font = kind === 'node' ? NODE_FONT : RING_FONT;
    const r = (a.inner + a.outer) / 2;
    // The text is a straight line along the middle of the arc: long text would leave the ring.
    const room = Math.min(2 * r * Math.sin(Math.min(a.end - a.start, Math.PI) / 2) - 3, MAX_TEXT);
    const glyph = font * GLYPH_SHARE;
    const hasIcon = !!labelIcon?.(a.label, ICON, undefined, kind);
    const iconRoom = hasIcon ? ICON + 2 : 0;
    const chars = Math.floor((room - iconRoom) / glyph);
    const icon = hasIcon;
    if (chars >= a.label.length) return { text: a.label, icon };
    if (!ringLabels) return null;
    if (chars >= 4) return { text: `${a.label.slice(0, chars - 1)}\u2026`, icon };
    if (hasIcon && room >= ICON + 1) return { text: '', icon };
    return null;
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
        const painted = a.kind === 'free' ? undefined : paint?.(a);
        const fill = isFree
          ? `url(#${hatchId})`
          : painted
          ? painted.fill
          : a.kind === 'node'
          ? theme.palette.text.primary
          : shade(a);
        const style = {
          fill,
          fillOpacity: a.kind === 'node' && !painted ? colours.nodeTone(a.nodeKey) : 1,
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
            {!customTooltip && <title>{arcTitle(a)}</title>}
          </path>
        ) : (
          <path key={id} {...common} {...style} role="img" aria-label={arcTitle(a)}>
            {!customTooltip && <title>{arcTitle(a)}</title>}
          </path>
        );
      })}
      {arcs.map(a => {
        const label = ringLabel(a);
        if (!label) return null;
        const kind = a.kind as ArcRef['kind'];
        const font = kind === 'node' ? NODE_FONT : RING_FONT;
        const mid = (a.start + a.end) / 2;
        const r = (a.inner + a.outer) / 2;
        const x = r * Math.sin(mid);
        const y = -r * Math.cos(mid);
        // Turn the text with the arc, and keep it upright in the lower half.
        const deg = (mid * 180) / Math.PI;
        const turn = deg > 90 && deg < 270 ? deg + 180 : deg;
        // A logo goes before the label. The logo and the label together stay centred on the arc.
        const textWidth = label.text.length * font * GLYPH_SHARE;
        const gap = label.text && label.icon ? 1 : 0;
        const icon = label.icon
          ? labelIcon?.(
              a.label,
              ICON,
              { x: x - (textWidth + ICON + gap) / 2, y: y - ICON / 2 },
              kind
            )
          : null;
        const ink = paint?.(a)?.ink ?? theme.palette.text.primary;
        const id = arcId(a);
        return (
          <g
            key={`label-${id}`}
            transform={`rotate(${turn.toFixed(2)} ${x.toFixed(3)} ${y.toFixed(3)})`}
            style={{ pointerEvents: 'none' }}
          >
            {icon && (
              <g data-node-icon={a.key} style={{ color: ink }}>
                {icon}
              </g>
            )}
            {label.text && (
              <text
                data-node-label={a.key}
                data-ring-label={a.kind}
                x={icon ? x + (ICON + gap) / 2 : x}
                y={y}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={font}
                fontWeight={kind === 'node' ? 600 : 500}
                fill={ink}
              >
                {label.text}
              </text>
            )}
          </g>
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
