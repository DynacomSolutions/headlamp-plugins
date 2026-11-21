/*
 * The stat tiles of a panel: no box and no divider. A large number sits over a small chip with the
 * status mark and the label. The chip carries the status tint, so the tint stays small and the
 * number stays calm. Only the worst non-zero tile colours its number. A zero value fades out. Status
 * is a shape and a word, never colour alone.
 */
import Box from '@mui/material/Box';
import React from 'react';
import type { PanelStatus, Stat } from './model';
import { StatusMark } from './StatusMark';
import { useTokens } from './tokens';

const RANK: Record<PanelStatus, number> = { crit: 3, warn: 2, unknown: 1, ok: 0 };
const isZero = (s: Stat): boolean => s.value.trim() === '0';

/** The index of the worst tile with a real (non-zero) value, or -1 when every tile is fine or zero. */
export function worstStat(stats: Stat[]): number {
  let best = -1;
  let rank = 0;
  stats.forEach((s, i) => {
    if (!isZero(s) && RANK[s.status] > rank) {
      rank = RANK[s.status];
      best = i;
    }
  });
  return best;
}

/** A tile is narrow when its share of the row is under 100 px. */
const NARROW = 100;
/** The numeral size in px by value length: short, medium, long. */
const SIZE = [34, 26, 20];
const SIZE_NARROW = [28, 22, 17];

const sizeIndex = (v: string): number => (v.length <= 3 ? 0 : v.length <= 5 ? 1 : 2);

/** The numeral size of a tile row. Every tile has the size that the longest value needs. */
export const tileSize = (stats: Stat[], narrow: boolean): number =>
  (narrow ? SIZE_NARROW : SIZE)[Math.max(0, ...stats.map(s => sizeIndex(s.value)))];

/** The height of the tile row in px. */
export const TILES_HEIGHT = 68;

export function StatTiles(props: { stats: Stat[]; width: number }): JSX.Element {
  const { stats, width } = props;
  const tk = useTokens();
  const narrow = width > 0 && width / Math.max(1, stats.length) < NARROW;
  const worst = worstStat(stats);
  const size = tileSize(stats, narrow);
  return (
    <Box
      data-stats
      sx={{
        display: 'flex',
        gap: narrow ? '6px' : '10px',
        height: TILES_HEIGHT,
        flex: 'none',
        alignItems: 'flex-start',
        pt: '4px',
      }}
    >
      {stats.map((s, i) => {
        const zero = isZero(s);
        const isWorst = i === worst;
        return (
          <Box
            key={`${s.label}-${i}`}
            data-stat
            data-stat-worst={isWorst ? '' : undefined}
            sx={{ flex: '1 1 0', minWidth: 0 }}
          >
            <Box
              component="div"
              sx={{
                fontSize: size,
                lineHeight: 1.05,
                letterSpacing: '-0.01em',
                whiteSpace: 'nowrap',
                fontVariantNumeric: 'tabular-nums',
                color: zero
                  ? tk.mut
                  : isWorst && (s.status === 'warn' || s.status === 'crit')
                  ? tk.status[s.status]
                  : tk.fg,
              }}
            >
              {s.value}
            </Box>
            <Box
              data-stat-chip
              sx={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '5px',
                maxWidth: '100%',
                mt: '6px',
                px: '7px',
                py: '2px',
                borderRadius: '10px',
                fontSize: narrow ? 11.5 : 12.5,
                lineHeight: 1.3,
                color: zero ? tk.mut : tk.fg,
                bgcolor: zero ? 'transparent' : tk.fill[s.status],
                boxShadow: zero ? `inset 0 0 0 1px ${tk.line}` : 'none',
              }}
            >
              <Box sx={{ display: 'flex', opacity: zero ? 0.4 : 1 }}>
                <StatusMark status={s.status} size={11} />
              </Box>
              <Box
                component="span"
                sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              >
                {s.label}
              </Box>
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}
