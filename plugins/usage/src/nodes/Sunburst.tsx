/*
 * One node's CPU or memory sunburst as SVG, for a touch screen: pointer events only, no hover,
 * no tooltips. A tap on an arc selects it (it grows and gets an outline; a second tap or a tap
 * beside the chart clears it); a tap on the centre disc goes up one level. Empty space (unused
 * capacity, unattributed) is an arc without fill that can be selected too. Labels and project
 * icons sit inside the arcs where they fit, and the centre disc describes the focus.
 * Every arc is also a focusable button with its value as its name, for keyboards and screen
 * readers.
 */
import { Icon } from '@iconify/react';
import { useTheme } from '@mui/material/styles';
import { arc as d3arc } from 'd3-shape';
import React from 'react';
import { formatBytes, formatCores, formatPercent } from '../units';
import {
  ARC_ICON,
  ARC_ICON_GAP,
  arcCentroid,
  arcIconSize,
  arcLabel,
  CentreLine,
  centreLines,
  CHAR_WIDTH,
  ICON_MAX,
} from './arcLabel';
import { ArcDatum, CENTRE, layoutSunburst } from './layout';
import { nameOf } from './names';
import { DEFAULT_RINGS } from './nodesUrl';
import { capacityZoom, NodeTree, Resource, SunNode } from './tree';
import { useIconUrl } from './useIconUrl';

const MOVE_LIMIT = 10;
const MIN_FONT = 14;
/** How far a selected arc grows outwards, and the room the chart keeps for it (px). */
const SELECT_GROW = 7;
const SELECT_PAD = SELECT_GROW + 3;
const FALLBACK_ICON = { kind: 'mdi' as const, name: 'folder' };

function fmt(resource: Resource, v: number): string {
  return resource === 'cpu' ? formatCores(v) : formatBytes(v);
}

/** Key path of every arc: arcs come in depth-first order, so a stack of keys gives each path. */
function withPaths(arcs: ArcDatum[], focus: string[]): { arc: ArcDatum; path: string[] }[] {
  const stack: string[] = [];
  return arcs.map(arc => {
    stack.length = arc.depth - 1;
    stack.push(arc.key);
    return { arc, path: [...focus, ...stack] };
  });
}

/** Drawn at (0, 0) to (size, size). Brand icons sit on a light badge so they read on any fill. */
function ArcIcon(props: {
  icon: NonNullable<SunNode['icon']>;
  size: number;
  /** Colour for icons that do not bring their own. */
  color: string;
}) {
  const { icon, size, color } = props;
  const url = useIconUrl(icon.kind === 'file' ? icon.src : undefined);
  const iconify = (i: { kind: string; name?: string; color?: string }) => {
    const badge = i.kind === 'simple-icons';
    const inner = badge ? Math.round(size * 0.68) : size;
    const off = (size - inner) / 2;
    return (
      <>
        {badge && (
          <circle
            data-icon-badge
            cx={size / 2}
            cy={size / 2}
            r={size / 2}
            fill="#fff"
            stroke="rgba(0,0,0,0.25)"
            style={{ pointerEvents: 'none' }}
          />
        )}
        <foreignObject x={off} y={off} width={inner} height={inner} style={{ pointerEvents: 'none' }}>
          <Icon
            icon={`${i.kind}:${i.name}`}
            width={inner}
            height={inner}
            color={badge ? '#1f2328' : i.color ?? color}
          />
        </foreignObject>
      </>
    );
  };
  if (icon.kind !== 'file') return iconify(icon);
  // While a project icon loads, and after it failed, the folder stands in for it.
  if (url === 'failed' || !url) return iconify({ ...FALLBACK_ICON, color });
  return (
    <image
      href={url}
      width={size}
      height={size}
      preserveAspectRatio="xMidYMid meet"
      style={{ pointerEvents: 'none' }}
    />
  );
}

export function Sunburst(props: {
  tree: NodeTree;
  resource: Resource;
  focus: string[];
  size: number;
  rings?: number;
  /** Called with the parent path when the centre is tapped (go up one level). */
  onFocus?: (path: string[]) => void;
  /** The selected path from the root, the same in both charts. */
  selected?: string[] | null;
  /** Called with the tapped arc's path, or null to clear the selection. */
  onSelect?: (path: string[] | null) => void;
  compact?: boolean;
  /** The focused node by name and icon, for the centre when this tree does not have it. */
  subject?: { label: string; icon?: SunNode['icon'] };
}) {
  const {
    tree,
    resource,
    focus,
    size,
    rings = DEFAULT_RINGS,
    onFocus,
    selected = null,
    onSelect,
    compact = false,
    subject,
  } = props;
  const theme = useTheme();
  // The chart keeps room for a selected arc to grow past the outer ring.
  const pad = compact ? 0 : SELECT_PAD;
  const radius = size / 2 - pad;
  const [pressed, setPressed] = React.useState<string | null>(null);
  const start = React.useRef<{ id: number; x: number; y: number } | null>(null);

  const {
    arcs,
    centre,
    focusNode,
    path: shown,
  } = React.useMemo(
    () => layoutSunburst(tree, focus, { radius, rings, mode: theme.palette.mode }),
    [tree, focus, radius, rings, theme.palette.mode]
  );
  // Arc paths start from the focus this tree has, which may be shallower than `focus` (a key
  // only the other chart has), so a tap always yields a path this tree can resolve.
  const items = React.useMemo(() => withPaths(arcs, shown), [arcs, shown]);
  const selectedId = selected ? selected.join('\u0000') : null;
  const pathOf = new Map(items.map(i => [i.arc, i.path.join('\u0000')]));
  const isSelected = (_key: string, a: ArcDatum) => selectedId !== null && pathOf.get(a) === selectedId;
  // The selected arc is drawn last, so its outline and growth are not covered.
  const drawn = [...items].sort((a, b) => Number(isSelected('', a.arc)) - Number(isSelected('', b.arc)));
  const name = resource === 'cpu' ? 'CPU' : 'Memory';
  // Zoomed in, percentages are of the active section (the focus node), not of capacity.
  // Zoomed into one node of a node ring it reads like a single-node root, against that capacity.
  const capZoom = capacityZoom(tree, shown);
  const zoomed = focus.length > 0 && capZoom === null;
  const sectionName = subject?.label ?? centre.title;
  const scope = zoomed
    ? `of ${sectionName}`
    : capZoom !== null
    ? 'of capacity'
    : tree.nodeRing
    ? 'of selection'
    : 'of node';
  const base = zoomed ? focusNode.value : capZoom ?? tree.capacity;
  // This chart has no data for the focus when its tree resolves a shorter path.
  const missing = shown.length < focus.length;
  const up = focus.length ? focus.slice(0, -1) : null;

  const shape = d3arc<ArcDatum>()
    .startAngle(a => a.x0)
    .endAngle(a => a.x1)
    .innerRadius(a => a.y0)
    .outerRadius(a => (isSelected(a.key, a) ? a.y1 + SELECT_GROW : a.y1))
    .cornerRadius(2)
    .padAngle(0.004);

  const release = (pointerId: number) => {
    if (start.current && start.current.id !== pointerId) return;
    start.current = null;
    setPressed(null);
  };

  const handlers = (id: string, act: (() => void) | null) =>
    compact
      ? {}
      : {
          onPointerDown: (e: React.PointerEvent) => {
            if (start.current) return;
            start.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
            setPressed(id);
          },
          onPointerUp: (e: React.PointerEvent) => {
            const s = start.current;
            if (!s || s.id !== e.pointerId) return;
            start.current = null;
            setPressed(null);
            if (!act) return;
            if (Math.hypot(e.clientX - s.x, e.clientY - s.y) > MOVE_LIMIT) return;
            e.stopPropagation();
            act();
          },
          onPointerLeave: (e: React.PointerEvent) => release(e.pointerId),
          onPointerCancel: (e: React.PointerEvent) => release(e.pointerId),
          onKeyDown: (e: React.KeyboardEvent) => {
            if (!act || (e.key !== 'Enter' && e.key !== ' ')) return;
            e.preventDefault();
            act();
          },
        };

  const top = [...(zoomed || capZoom !== null ? focusNode : tree.root).children]
    .sort((a, b) => b.value - a.value)
    .slice(0, 5)
    .map(c => `${c.label} ${formatPercent(c.value, base)}`)
    .join(', ');
  const aria = `${name} usage by group: ${top}`;
  const fontSize = Math.max(MIN_FONT, size / 40);
  const centreR = radius * CENTRE;
  // The centre text grows with the chart, from 14 px.
  const centreFont = Math.max(14, size / 50);
  // Arc icons grow with the chart too, so a big chart reads from across the room.
  const iconMax = Math.max(ICON_MAX, Math.round(size / 28));

  const title = subject?.label ?? centre.title;
  const centreIcon = subject ? subject.icon : focusNode.icon;
  const lines: CentreLine[] = compact
    ? []
    : centreLines(centreR, centreFont, {
        title,
        icon: !!centreIcon,
        ...(missing
          ? { value: `no ${resource === 'cpu' ? 'CPU' : 'memory'} data` }
          : zoomed
          ? { value: fmt(resource, centre.value) }
          : {
              value: fmt(resource, centre.value),
              node: `${formatPercent(centre.share, 1)} ${scope}`,
              nodeShort: formatPercent(centre.share, 1),
              parent:
                centre.parentShare === null || capZoom !== null
                  ? undefined
                  : `${formatPercent(centre.parentShare, 1)} of parent`,
            }),
      });
  const centreText = lines
    .filter(l => l.kind !== 'icon')
    .map(l => l.text)
    .join(', ');

  return (
    <svg
      role={compact ? 'img' : 'group'}
      aria-label={aria}
      width={size}
      height={size}
      viewBox={`${-size / 2} ${-size / 2} ${size} ${size}`}
      style={{ touchAction: 'manipulation', userSelect: 'none', maxWidth: '100%' }}
      onPointerUp={e => {
        // A tap beside the arcs, still inside the chart, clears the selection.
        if (!compact && e.target === e.currentTarget) onSelect?.(null);
      }}
    >
      <style>{`.sb-arc{outline:none}.sb-arc:focus-visible{stroke:${theme.palette.primary.main};stroke-width:3px;stroke-dasharray:none;stroke-opacity:1}`}</style>
      <circle
        data-rim
        r={radius}
        fill="none"
        stroke={theme.palette.text.secondary}
        strokeOpacity={0.4}
        strokeDasharray="2 4"
        style={{ pointerEvents: 'none' }}
      />
      {drawn.map(({ arc, path }) => {
        const id = path.join('/');
        const chosen = isSelected(arc.key, arc);
        const ink = arc.gap ? theme.palette.text.primary : theme.palette.getContrastText(arc.fill);
        // Icons come first: an arc with an icon shows it as large as fits, and its name beside
        // or under it only when both fit.
        const icon = compact || arc.gap ? undefined : arc.node.icon;
        const iconSize = icon ? arcIconSize(arc, iconMax) : null;
        // An arc with an icon shows the whole name or none: never a clipped stub. Without room
        // for the name beside it the icon stands alone. An arc with no icon may show a clipped
        // name when at least 8 characters fit.
        const fitted =
          compact || arc.gap
            ? null
            : arcLabel(arc, nameOf(arc.node), fontSize, iconSize !== null, iconSize ?? 0, 8);
        const whole = !!fitted && fitted.text === nameOf(arc.node);
        let label = fitted;
        if (icon) label = whole && (iconSize === null || fitted?.icon) ? fitted : null;
        const lone = icon && iconSize !== null && !label ? arcCentroid(arc) : null;
        const a11y = compact
          ? {}
          : {
              role: 'button',
              tabIndex: 0,
              'aria-label': `${nameOf(arc.node)}: ${fmt(resource, arc.node.value)}, ${formatPercent(
                arc.node.value,
                base
              )} ${arc.gap && !zoomed ? 'of capacity' : scope}`,
            };
        return (
          <g key={id}>
            <path
              className="sb-arc"
              data-key={arc.key}
              d={shape(arc) ?? ''}
              data-selected={chosen ? 'true' : undefined}
              data-gap={arc.gap ? 'true' : undefined}
              fill={arc.fill}
              stroke={
                chosen
                  ? theme.palette.primary.main
                  : arc.gap
                  ? theme.palette.text.secondary
                  : theme.palette.background.paper
              }
              strokeWidth={chosen ? 3 : 1}
              strokeDasharray={arc.gap && !chosen ? '2 4' : undefined}
              strokeOpacity={arc.gap && !chosen ? 0.6 : 1}
              style={{
                // An arc without fill still takes taps.
                pointerEvents: 'all',
                cursor: compact ? undefined : 'pointer',
                transform: pressed === id ? 'scale(1.03)' : '',
                transition: 'transform 80ms',
              }}
              {...a11y}
              aria-pressed={compact ? undefined : chosen}
              {...handlers(id, () => onSelect?.(chosen ? null : path))}
            />
            {lone && icon && iconSize !== null && (
              <g
                data-arc-icon={arc.key}
                transform={`translate(${lone.x - iconSize / 2} ${lone.y - iconSize / 2})`}
                style={{ pointerEvents: 'none' }}
                aria-hidden="true"
              >
                <ArcIcon icon={icon} size={iconSize} color={ink} />
              </g>
            )}
            {label && (
              <g
                transform={`translate(${label.x} ${label.y}) rotate(${label.rotate})`}
                style={{ pointerEvents: 'none' }}
                aria-hidden="true"
              >
                {label.icon && arc.node.icon && (
                  <g transform={`translate(${-label.width / 2} ${-label.iconSize / 2})`}>
                    <ArcIcon icon={arc.node.icon} size={label.iconSize} color={ink} />
                  </g>
                )}
                <text
                  data-arc-label={label.orientation}
                  x={label.icon ? -label.width / 2 + label.iconSize + ARC_ICON_GAP : 0}
                  textAnchor={label.icon ? 'start' : 'middle'}
                  dominantBaseline="central"
                  fontSize={fontSize}
                  fill={ink}
                >
                  {label.text}
                </text>
              </g>
            )}
          </g>
        );
      })}
      <circle
        data-centre
        r={centreR}
        fill={theme.palette.background.paper}
        stroke={theme.palette.divider}
        style={{ cursor: !compact && up ? 'pointer' : undefined }}
        {...(!compact && up
          ? {
              role: 'button',
              tabIndex: 0,
              'aria-label': `${centreText}. Up one level`,
            }
          : {})}
        {...handlers('centre', up ? () => onFocus?.(up) : null)}
      />
      <g style={{ pointerEvents: 'none' }} textAnchor="middle" fill={theme.palette.text.primary}>
        {compact ? (
          // Zoomed in, 100% of the focus says nothing, so the compact centre stays empty.
          !zoomed && (
          <text
            y={0}
            dominantBaseline="central"
            fontSize={Math.min(fontSize * 1.8, (centreR * 1.6) / 3 / CHAR_WIDTH)}
            fontWeight={600}
          >
            {Math.round(centre.share * 100)}%
          </text>
          )
        ) : (
          lines.map(l =>
            l.kind === 'icon' ? (
              centreIcon && (
                <g key="icon" transform={`translate(${-ARC_ICON / 2} ${l.y})`}>
                  <ArcIcon icon={centreIcon} size={ARC_ICON} color={theme.palette.text.primary} />
                </g>
              )
            ) : (
              <text
                key={l.kind}
                data-centre-line={l.kind}
                y={l.y}
                fontSize={l.fontSize}
                fontWeight={l.kind === 'value' ? 600 : undefined}
                fill={
                  l.kind === 'title' || l.kind === 'value'
                    ? theme.palette.text.primary
                    : theme.palette.text.secondary
                }
                aria-hidden={up ? 'true' : undefined}
              >
                {l.text}
              </text>
            )
          )
        )}
      </g>
    </svg>
  );
}
