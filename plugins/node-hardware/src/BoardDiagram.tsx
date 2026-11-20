/** Inline SVG of the board layout. Colours come from the MUI theme through one small state map. */
import Box from '@mui/material/Box';
import { alpha, Theme, useTheme } from '@mui/material/styles';
import Typography from '@mui/material/Typography';
import React from 'react';
import { BoardLayout, layoutBoard, ShapeState } from './boardLayout';
import { HardwareProfile } from './inventory';

const VIEW_WIDTH = 960;

interface Look {
  fill: string;
  stroke: string;
  strokeWidth: number;
}

/** The only place that maps a semantic state to a colour. */
export function paletteFor(theme: Theme): Record<ShapeState, Look> {
  const p = theme.palette;
  return {
    board: { fill: alpha(p.text.primary, 0.03), stroke: p.text.disabled, strokeWidth: 2 },
    panel: { fill: 'none', stroke: p.divider, strokeWidth: 1 },
    filled: { fill: alpha(p.primary.main, 0.22), stroke: p.primary.main, strokeWidth: 1.5 },
    empty: { fill: 'none', stroke: p.text.secondary, strokeWidth: 1 },
    warn: { fill: alpha(p.warning.main, 0.3), stroke: p.warning.main, strokeWidth: 2.5 },
    chip: { fill: alpha(p.text.primary, 0.08), stroke: p.text.secondary, strokeWidth: 1 },
    placeholder: { fill: 'none', stroke: p.text.disabled, strokeWidth: 1 },
  };
}

function Swatch({ look, dashed }: { look: Look; dashed?: boolean }): JSX.Element {
  return (
    <svg width="22" height="14" aria-hidden="true" focusable="false">
      <rect x="1.5" y="1.5" width="19" height="11" rx="2" fill={look.fill} stroke={look.stroke} strokeWidth={look.strokeWidth} strokeDasharray={dashed ? '4 2' : undefined} />
    </svg>
  );
}

export function describeLayout(layout: BoardLayout, profile: HardwareProfile): string {
  const dimms = layout.shapes.filter(s => s.id.startsWith('dimm-'));
  const used = dimms.filter(s => s.state !== 'empty').length;
  const slots = layout.shapes.filter(s => s.id.startsWith('slot-'));
  const warn = layout.shapes.filter(s => s.state === 'warn').length;
  const board = profile.board ? `${profile.board.vendor} ${profile.board.model}`.trim() : profile.node;
  return `Schematic of ${board}: ${used} of ${dimms.length} memory slots filled, ${slots.length} PCIe slots, ${layout.shapes.filter(s => s.id.startsWith('m2-')).length} M.2 sockets, ${warn} items need attention.`;
}

export function BoardDiagram({ profile }: { profile: HardwareProfile }): JSX.Element {
  const theme = useTheme();
  const look = paletteFor(theme);
  const layout = React.useMemo(() => layoutBoard(profile, VIEW_WIDTH), [profile]);
  return (
    <Box sx={{ mb: 2 }}>
      <svg
        role="img"
        aria-label={describeLayout(layout, profile)}
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        style={{ width: '100%', height: 'auto', maxWidth: layout.width, display: 'block' }}
        fontFamily={theme.typography.fontFamily}
      >
        {layout.shapes.map(s => {
          const l = look[s.state];
          return (
            <g key={s.id}>
              <title>{s.title}</title>
              <rect x={s.x} y={s.y} width={s.w} height={s.h} rx={4} fill={l.fill} stroke={l.stroke} strokeWidth={l.strokeWidth} strokeDasharray={s.dashed ? '5 3' : undefined} />
              {s.labels.map((t, i) => (
                <text key={i} x={t.x} y={t.y} fontSize={t.size ?? 12} fontWeight={t.weight ?? 'normal'} textAnchor={t.anchor ?? 'start'} fill={t.tone === 'muted' ? theme.palette.text.secondary : theme.palette.text.primary} pointerEvents="none">
                  {t.text}
                </text>
              ))}
            </g>
          );
        })}
      </svg>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 2, mt: 0.5, alignItems: 'center' }}>
        <Typography variant="caption" sx={{ display: 'flex', gap: 0.5, alignItems: 'center' }}>
          <Swatch look={look.filled} /> Filled
        </Typography>
        <Typography variant="caption" sx={{ display: 'flex', gap: 0.5, alignItems: 'center' }}>
          <Swatch look={look.empty} /> Empty
        </Typography>
        <Typography variant="caption" sx={{ display: 'flex', gap: 0.5, alignItems: 'center' }}>
          <Swatch look={look.warn} /> Below max width or rated speed
        </Typography>
        <Typography variant="caption" sx={{ display: 'flex', gap: 0.5, alignItems: 'center' }}>
          <Swatch look={look.empty} dashed /> Lane count unknown (drawn as x16)
        </Typography>
        <Typography variant="caption" color="text.secondary">
          Schematic, not physical. Hover a shape for details.
        </Typography>
      </Box>
    </Box>
  );
}
