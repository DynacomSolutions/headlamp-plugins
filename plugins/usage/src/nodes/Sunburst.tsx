/*
 * One node's CPU or memory sunburst as SVG, for a touch screen: pointer events only, no hover,
 * no tooltips. A tap on an arc focuses it; a tap on the centre disc goes up one level.
 */
import { Icon } from '@iconify/react';
import { useTheme } from '@mui/material/styles';
import { arc as d3arc } from 'd3-shape';
import React from 'react';
import { formatBytes, formatCores, formatPercent } from '../units';
import { ArcDatum, layoutSunburst } from './layout';
import { NodeTree, Resource, SunNode } from './tree';
import { useIconUrl } from './useIconUrl';

const MOVE_LIMIT = 10;
const CENTRE = 0.3;
const MIN_FONT = 14;
const CHAR_WIDTH = 0.6;
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

function ArcIcon({ icon, size }: { icon: NonNullable<SunNode['icon']>; size: number }) {
  const url = useIconUrl(icon.kind === 'file' ? icon.src : undefined);
  const iconify = (i: { kind: string; name?: string; color?: string }) => (
    <foreignObject width={size} height={size} style={{ pointerEvents: 'none' }}>
      <Icon icon={`${i.kind}:${i.name}`} width={size} height={size} color={i.color} />
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
}) {
  const { tree, resource, focus, size, rings = 3, onFocus, compact = false } = props;
  const theme = useTheme();
  const radius = size / 2;
  const [pressed, setPressed] = React.useState<string | null>(null);
  const start = React.useRef<{ id: number; x: number; y: number } | null>(null);

  const { arcs, centre } = React.useMemo(
    () => layoutSunburst(tree, focus, { radius, rings, mode: theme.palette.mode }),
    [tree, focus, radius, rings, theme.palette.mode]
  );
  const items = React.useMemo(() => withPaths(arcs, focus), [arcs, focus]);

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
        };

  const top = [...tree.root.children]
    .sort((a, b) => b.value - a.value)
    .slice(0, 5)
    .map(c => `${c.label} ${formatPercent(c.value, tree.capacity)}`)
    .join(', ');
  const aria = `${resource === 'cpu' ? 'CPU' : 'Memory'} usage by group: ${top}`;
  const fontSize = Math.max(MIN_FONT, size / 40);
  const fits = (text: string, width: number) => text.length * fontSize * CHAR_WIDTH <= width;
  const clip = (text: string, width: number) => {
    const max = Math.max(1, Math.floor(width / (fontSize * CHAR_WIDTH)));
    return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}\u2026`;
  };
  const discWidth = radius * CENTRE * 1.6;

  return (
    <svg
      role="img"
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
        const [cx, cy] = shape.centroid(arc);
        const ringW = arc.y1 - arc.y0;
        const iconSize = Math.min(24, ringW * 0.7);
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
              {...handlers(id, path)}
            />
            {!compact && arc.showIcon && arc.node.icon && (
              <g transform={`translate(${cx - iconSize / 2} ${cy - iconSize / 2 - fontSize})`}>
                <ArcIcon icon={arc.node.icon} size={iconSize} />
              </g>
            )}
            {!compact &&
              arc.label &&
              fits(arc.label, ((arc.x1 - arc.x0) * (arc.y0 + arc.y1)) / 2 - 4) &&
              ringW >= fontSize + 4 && (
                <text
                  data-arc-label
                  x={cx}
                  y={arc.showIcon && arc.node.icon ? cy + iconSize / 2 : cy}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fontSize={fontSize}
                  fill={theme.palette.getContrastText(arc.fill)}
                  style={{ pointerEvents: 'none' }}
                >
                  {arc.label}
                </text>
              )}
          </g>
        );
      })}
      <circle
        data-centre
        r={radius * CENTRE}
        fill={theme.palette.background.paper}
        stroke={theme.palette.divider}
        style={{ cursor: !compact && focus.length ? 'pointer' : undefined }}
        {...handlers('centre', focus.length ? focus.slice(0, -1) : null)}
      />
      <g style={{ pointerEvents: 'none' }} textAnchor="middle" fill={theme.palette.text.primary}>
        {!compact && (
          <text y={-fontSize * 1.4} fontSize={fontSize} fill={theme.palette.text.secondary}>
            {clip(centre.title, discWidth)}
          </text>
        )}
        <text
          y={compact ? 0 : fontSize * 0.4}
          fontSize={Math.min(fontSize * 1.8, discWidth / 3 / CHAR_WIDTH)}
          fontWeight={600}
        >
          {Math.round(centre.share * 100)}%
        </text>
        {!compact && (
          <text y={fontSize * 2} fontSize={fontSize} fill={theme.palette.text.secondary}>
            {clip(fmt(resource, centre.value), discWidth)}
          </text>
        )}
      </g>
    </svg>
  );
}
