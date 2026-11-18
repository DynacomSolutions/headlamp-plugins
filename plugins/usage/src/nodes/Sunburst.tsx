/*
 * One node's CPU or memory sunburst as SVG, for a touch screen: pointer events only, no hover,
 * no tooltips. A tap on an arc focuses it; a tap on the centre disc goes up one level. Labels and
 * project icons sit inside the arcs where they fit, and the centre disc describes the focus.
 * Every arc is also a focusable button with its value as its name, for keyboards and screen
 * readers.
 */
import { Icon } from '@iconify/react';
import { useTheme } from '@mui/material/styles';
import { arc as d3arc } from 'd3-shape';
import React from 'react';
import { formatBytes, formatCores, formatPercent } from '../units';
import { ARC_ICON, ARC_ICON_GAP, arcLabel, CentreLine, centreLines, CHAR_WIDTH } from './arcLabel';
import { ArcDatum, CENTRE, layoutSunburst } from './layout';
import { NodeTree, Resource, SunNode } from './tree';
import { useIconUrl } from './useIconUrl';

const MOVE_LIMIT = 10;
const MIN_FONT = 14;
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

function ArcIcon(props: {
  icon: NonNullable<SunNode['icon']>;
  size: number;
  /** Colour for icons that do not bring their own. */
  color: string;
}) {
  const { icon, size, color } = props;
  const url = useIconUrl(icon.kind === 'file' ? icon.src : undefined);
  const iconify = (i: { kind: string; name?: string; color?: string }) => (
    <foreignObject width={size} height={size} style={{ pointerEvents: 'none' }}>
      <Icon icon={`${i.kind}:${i.name}`} width={size} height={size} color={i.color ?? color} />
    </foreignObject>
  );
  if (icon.kind !== 'file') return iconify(icon);
  if (url === 'failed') return iconify(FALLBACK_ICON);
  if (!url) return null;
  return <image href={url} width={size} height={size} style={{ pointerEvents: 'none' }} />;
}

export function Sunburst(props: {
  tree: NodeTree;
  resource: Resource;
  focus: string[];
  size: number;
  rings?: number;
  onFocus?: (path: string[]) => void;
  compact?: boolean;
  /** The focused node by name and icon, for the centre when this tree does not have it. */
  subject?: { label: string; icon?: SunNode['icon'] };
}) {
  const { tree, resource, focus, size, rings = 3, onFocus, compact = false, subject } = props;
  const theme = useTheme();
  const radius = size / 2;
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
  const name = resource === 'cpu' ? 'CPU' : 'Memory';
  // This chart has no data for the focus when its tree resolves a shorter path.
  const missing = shown.length < focus.length;
  const up = focus.length ? focus.slice(0, -1) : null;

  const shape = d3arc<ArcDatum>()
    .startAngle(a => a.x0)
    .endAngle(a => a.x1)
    .innerRadius(a => a.y0)
    .outerRadius(a => a.y1)
    .cornerRadius(2)
    .padAngle(0.004);

  const release = (pointerId: number) => {
    if (start.current && start.current.id !== pointerId) return;
    start.current = null;
    setPressed(null);
  };

  const handlers = (id: string, target: string[] | null) =>
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
            if (!target) return;
            if (Math.hypot(e.clientX - s.x, e.clientY - s.y) > MOVE_LIMIT) return;
            onFocus?.(target);
          },
          onPointerLeave: (e: React.PointerEvent) => release(e.pointerId),
          onPointerCancel: (e: React.PointerEvent) => release(e.pointerId),
          onKeyDown: (e: React.KeyboardEvent) => {
            if (!target || (e.key !== 'Enter' && e.key !== ' ')) return;
            e.preventDefault();
            onFocus?.(target);
          },
        };

  const top = [...tree.root.children]
    .sort((a, b) => b.value - a.value)
    .slice(0, 5)
    .map(c => `${c.label} ${formatPercent(c.value, tree.capacity)}`)
    .join(', ');
  const aria = `${name} usage by group: ${top}`;
  const fontSize = Math.max(MIN_FONT, size / 40);
  const centreR = radius * CENTRE;

  const title = subject?.label ?? centre.title;
  const centreIcon = subject ? subject.icon : focusNode.icon;
  const lines: CentreLine[] = compact
    ? []
    : centreLines(centreR, fontSize, {
        title,
        icon: !!centreIcon,
        ...(missing
          ? { value: `no ${resource === 'cpu' ? 'CPU' : 'memory'} data` }
          : {
              value: fmt(resource, centre.value),
              node: `${formatPercent(centre.share, 1)} of node`,
              parent:
                centre.parentShare === null
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
      viewBox={`${-radius} ${-radius} ${size} ${size}`}
      style={{ touchAction: 'manipulation', userSelect: 'none', maxWidth: '100%' }}
    >
      <circle
        data-outline
        r={radius}
        fill="none"
        stroke={theme.palette.divider}
        strokeDasharray="4 4"
      />
      {items.map(({ arc, path }) => {
        const id = path.join('/');
        const ink = theme.palette.getContrastText(arc.fill);
        const wantIcon = arc.node.kind === 'project' && !!arc.node.icon;
        const label = compact ? null : arcLabel(arc, arc.node.label, fontSize, wantIcon);
        const a11y = compact
          ? {}
          : {
              role: 'button',
              tabIndex: 0,
              'aria-label': `${arc.node.label}: ${fmt(resource, arc.node.value)}, ${formatPercent(
                arc.node.value,
                tree.capacity
              )} of node`,
            };
        return (
          <g key={id}>
            <path
              data-key={arc.key}
              d={shape(arc) ?? ''}
              fill={arc.fill}
              stroke={theme.palette.background.paper}
              strokeWidth={1}
              style={{
                cursor: compact ? undefined : 'pointer',
                transform: pressed === id ? 'scale(1.03)' : '',
                transition: 'transform 80ms',
              }}
              {...a11y}
              {...handlers(id, path)}
            />
            {label && (
              <g
                transform={`translate(${label.x} ${label.y}) rotate(${label.rotate})`}
                style={{ pointerEvents: 'none' }}
                aria-hidden="true"
              >
                {label.icon && arc.node.icon && (
                  <g transform={`translate(${-label.width / 2} ${-ARC_ICON / 2})`}>
                    <ArcIcon icon={arc.node.icon} size={ARC_ICON} color={ink} />
                  </g>
                )}
                <text
                  data-arc-label={label.orientation}
                  x={label.icon ? -label.width / 2 + ARC_ICON + ARC_ICON_GAP : 0}
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
        {...handlers('centre', up)}
      />
      <g style={{ pointerEvents: 'none' }} textAnchor="middle" fill={theme.palette.text.primary}>
        {compact ? (
          <text
            y={0}
            dominantBaseline="central"
            fontSize={Math.min(fontSize * 1.8, (centreR * 1.6) / 3 / CHAR_WIDTH)}
            fontWeight={600}
          >
            {Math.round(centre.share * 100)}%
          </text>
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
