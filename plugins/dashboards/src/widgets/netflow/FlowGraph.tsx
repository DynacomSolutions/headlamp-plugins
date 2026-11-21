/*
 * The flow graph: one circle for each node on a fixed ellipse, one line for each pair of nodes.
 * The colour of a line is the worst loss of the pair (grey and dashed with no data, never drawn as
 * zero). A warning line has a triangle at its middle and a critical line a square, so colour is not
 * the only cue. The width of a line is the traffic of the pair, with a thin minimum. Nothing moves:
 * the graph stays calm on a wall display. A tooltip lists loss, round trip time and rate of each
 * direction. A tap or the keyboard opens it too.
 */
import Box from '@mui/material/Box';
import React from 'react';
import type { PanelStatus } from '../panels/model';
import { Ink } from '../promql/palette';
import {
  FlowView,
  formatShare,
  GROUPS,
  lineWidth,
  NodeHealth,
  pairLines,
  PairView,
  Point,
  ringLayout,
  SEVERITY_ORDER,
} from './model';

interface Tip {
  /** A pair key `a|b` or a node name. */
  id: string;
  kind: 'pair' | 'node';
  x: number;
  y: number;
}

const NODE_R = 6;

/** Text anchor and offset of a node label, so the label sits outside the ring. */
export function labelPlace(
  p: Point,
  c: Point
): { anchor: 'start' | 'middle' | 'end'; dx: number; dy: number } {
  const dx = p.x - c.x;
  const dy = p.y - c.y;
  if (Math.abs(dx) < 12)
    return { anchor: 'middle', dx: 0, dy: dy < 0 ? -(NODE_R + 5) : NODE_R + 13 };
  return { anchor: dx > 0 ? 'start' : 'end', dx: dx > 0 ? NODE_R + 5 : -(NODE_R + 5), dy: 4 };
}

const short = (name: string, max: number) =>
  name.length > max ? `${name.slice(0, Math.max(1, max - 1))}…` : name;

export function FlowGraph({
  view,
  health,
  nodes,
  width,
  height,
  ink,
  colours,
}: {
  view: FlowView;
  health: NodeHealth[];
  nodes: string[];
  width: number;
  height: number;
  ink: Ink;
  colours: Record<PanelStatus, string>;
}): JSX.Element {
  const [tip, setTip] = React.useState<Tip | undefined>();
  const rootRef = React.useRef<HTMLDivElement>(null);
  const longest = nodes.reduce((m, n) => Math.max(m, n.length), 0);
  const labelW = Math.min(64, Math.max(16, Math.min(longest, 10) * 6.4));
  const cx = width / 2;
  const cy = height / 2;
  const rx = Math.max(10, width / 2 - NODE_R - labelW - 6);
  const ry = Math.max(10, height / 2 - NODE_R - 16);
  const points = React.useMemo(
    () => ringLayout(nodes.length, cx, cy, rx, ry),
    [nodes.length, cx, cy, rx, ry]
  );
  const at = new Map(nodes.map((n, i) => [n, points[i]]));
  // The worst lines draw last, so they stay on top.
  const ordered = [...view.pairs].sort((a, b) => {
    const s = SEVERITY_ORDER[a.status] - SEVERITY_ORDER[b.status];
    return s !== 0 ? s : (a.rate ?? 0) - (b.rate ?? 0);
  });
  const healthOf = new Map(health.map(h => [h.name, h]));

  const place = (e: React.MouseEvent | React.PointerEvent): { x: number; y: number } => {
    const r = rootRef.current?.getBoundingClientRect();
    return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) };
  };
  const show = (kind: Tip['kind'], id: string, e: React.MouseEvent | React.PointerEvent) =>
    setTip({ kind, id, ...place(e) });
  const showAt = (kind: Tip['kind'], id: string, p: Point) => setTip({ kind, id, x: p.x, y: p.y });

  const tipLines = (): string[] => {
    if (!tip) return [];
    if (tip.kind === 'pair') {
      const p = view.pairs.find(v => `${v.a}|${v.b}` === tip.id);
      return p ? pairLines(p) : [];
    }
    const h = healthOf.get(tip.id);
    if (!h) return [];
    return [tip.id, ...nodeTipLines(h)];
  };
  const lines = tipLines();
  const tipLeft = tip ? Math.min(Math.max(4, tip.x + 12), Math.max(4, width - 230)) : 0;
  const tipTop = tip ? Math.min(Math.max(4, tip.y + 12), Math.max(4, height - 20)) : 0;

  const pairKey = (p: PairView) => `${p.a}|${p.b}`;
  return (
    <Box
      ref={rootRef}
      data-flow-graph
      sx={{ position: 'relative', width, height, flex: 'none' }}
      onMouseLeave={() => setTip(undefined)}
    >
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="group"
        aria-label="Network flow between nodes"
      >
        {ordered.map(p => {
          const from = at.get(p.a);
          const to = at.get(p.b);
          if (!from || !to) return null;
          const noData = p.status === 'unknown';
          const colour = noData ? ink.muted : colours[p.status];
          const w = lineWidth(p.rate, view.maxRate);
          const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
          const label = pairLines(p).join('. ');
          return (
            <g
              key={pairKey(p)}
              data-flow-pair={pairKey(p)}
              data-status={p.status}
              data-width={w.toFixed(2)}
              role="button"
              tabIndex={0}
              aria-label={label}
              style={{ cursor: 'pointer', outline: 'none' }}
              onMouseEnter={e => show('pair', pairKey(p), e)}
              onMouseMove={e => show('pair', pairKey(p), e)}
              onClick={e =>
                tip?.id === pairKey(p) ? setTip(undefined) : show('pair', pairKey(p), e)
              }
              onFocus={() => showAt('pair', pairKey(p), mid)}
              onBlur={() => setTip(undefined)}
              onKeyDown={e => {
                if (e.key === 'Escape') setTip(undefined);
              }}
            >
              <line
                x1={from.x}
                y1={from.y}
                x2={to.x}
                y2={to.y}
                stroke="transparent"
                strokeWidth={12}
              />
              <line
                x1={from.x}
                y1={from.y}
                x2={to.x}
                y2={to.y}
                stroke={colour}
                strokeWidth={noData ? 1 : w}
                strokeOpacity={noData ? 0.55 : p.status === 'ok' ? 0.6 : 0.95}
                strokeDasharray={noData ? '2 4' : undefined}
                strokeLinecap="round"
              />
              {p.status === 'warn' && (
                <path
                  d={`M${mid.x} ${mid.y - 5} L${mid.x + 5} ${mid.y + 4} L${mid.x - 5} ${
                    mid.y + 4
                  } Z`}
                  fill={colour}
                  stroke={ink.ring}
                  strokeWidth={1}
                />
              )}
              {p.status === 'crit' && (
                <rect
                  x={mid.x - 4.5}
                  y={mid.y - 4.5}
                  width={9}
                  height={9}
                  rx={1}
                  fill={colour}
                  stroke={ink.ring}
                  strokeWidth={1}
                />
              )}
            </g>
          );
        })}
        {nodes.map((n, i) => {
          const p = points[i];
          const h = healthOf.get(n);
          const status: PanelStatus = h?.status ?? 'unknown';
          const place2 = labelPlace(p, { x: cx, y: cy });
          return (
            <g
              key={n}
              data-flow-node={n}
              data-status={status}
              role="button"
              tabIndex={0}
              aria-label={[n, ...(h ? nodeTipLines(h) : [])].join('. ')}
              style={{ cursor: 'pointer', outline: 'none' }}
              onMouseEnter={e => show('node', n, e)}
              onMouseMove={e => show('node', n, e)}
              onClick={e => (tip?.id === n ? setTip(undefined) : show('node', n, e))}
              onFocus={() => showAt('node', n, p)}
              onBlur={() => setTip(undefined)}
              onKeyDown={e => {
                if (e.key === 'Escape') setTip(undefined);
              }}
            >
              <circle cx={p.x} cy={p.y} r={NODE_R + 4} fill="transparent" />
              <circle
                cx={p.x}
                cy={p.y}
                r={NODE_R}
                fill={status === 'unknown' ? ink.surface : colours[status]}
                stroke={status === 'unknown' ? ink.muted : ink.ring}
                strokeWidth={status === 'unknown' ? 2 : 1.5}
              />
              <text
                x={p.x + place2.dx}
                y={p.y + place2.dy}
                textAnchor={place2.anchor}
                fontSize={11}
                fill={ink.primary}
              >
                {short(n, 10)}
              </text>
            </g>
          );
        })}
      </svg>
      {tip && lines.length > 0 && (
        <Box
          role="tooltip"
          data-flow-tip
          sx={{
            position: 'absolute',
            left: tipLeft,
            top: tipTop,
            maxWidth: 260,
            px: 1,
            py: 0.5,
            borderRadius: '6px',
            bgcolor: ink.surface,
            color: ink.primary,
            border: `1px solid ${ink.axis}`,
            fontSize: 11,
            lineHeight: 1.35,
            pointerEvents: 'none',
            zIndex: 3,
            boxShadow: '0 2px 8px rgba(0,0,0,0.5)',
          }}
        >
          {lines.map((l, i) => (
            <div key={i} style={{ fontWeight: i === 0 ? 700 : 400 }}>
              {l}
            </div>
          ))}
        </Box>
      )}
    </Box>
  );
}

/** The tooltip lines of a node: the share of each interface group and the TCP retransmit share. */
export function nodeTipLines(h: NodeHealth): string[] {
  return [
    ...GROUPS.map(g => `${g.label} drop and error ${formatShare(h.groups[g.id])}`),
    `TCP retransmit ${formatShare(h.retransmit)}`,
  ];
}
