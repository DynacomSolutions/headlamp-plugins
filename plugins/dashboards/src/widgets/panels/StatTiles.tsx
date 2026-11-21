/*
 * The stat tiles of a panel: a status tint, a status mark and a word, and a large number. The
 * worst tile with a real value is wider and has the largest number. A zero value is a quiet
 * outline, so the tile that matters stands out. Status is a shape and a word, never colour alone.
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
const SIZE = [42, 32, 24];
const SIZE_WORST = [58, 44, 30];
const SIZE_NARROW = 26;
const SIZE_NARROW_WORST = 30;
const SIZE_GRID = 30;

const sizeIndex = (v: string): number => (v.length <= 3 ? 0 : v.length <= 5 ? 1 : 2);

/** The height in px of the tile block for a width, so the panel can count how many rows fit. */
export function tilesHeight(count: number, width: number): number {
  if (count === 0) return 0;
  const narrow = width > 0 && width / count < NARROW;
  if (narrow && count > 3) {
    const rows = Math.ceil(count / 2);
    return rows * 62 + (rows - 1) * 6;
  }
  return 84;
}

export function StatTiles(props: { stats: Stat[]; width: number }): JSX.Element {
  const { stats, width } = props;
  const tk = useTokens();
  const narrow = width > 0 && width / Math.max(1, stats.length) < NARROW;
  const grid = narrow && stats.length > 3;
  const worst = worstStat(stats);
  return (
    <Box
      data-stats
      sx={
        grid
          ? {
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gridAutoRows: 62,
              gap: '6px',
              flex: 'none',
            }
          : { display: 'flex', gap: stats.length > 3 ? '4px' : '6px', height: 84, flex: 'none' }
      }
    >
      {stats.map((s, i) => {
        const zero = isZero(s);
        const isWorst = i === worst;
        const size = grid
          ? SIZE_GRID
          : narrow
          ? isWorst
            ? SIZE_NARROW_WORST
            : SIZE_NARROW
          : (isWorst ? SIZE_WORST : SIZE)[sizeIndex(s.value)];
        return (
          <Box
            key={`${s.label}-${i}`}
            data-stat
            data-stat-worst={isWorst ? '' : undefined}
            sx={{
              flex: grid ? 'none' : isWorst ? '1.8 1 0' : '1 1 0',
              minWidth: 0,
              borderRadius: '8px',
              px: stats.length > 3 || narrow ? 1 : 1.25,
              pt: '7px',
              pb: '5px',
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'space-between',
              bgcolor: zero ? 'transparent' : tk.fill[s.status],
              boxShadow: zero ? `inset 0 0 0 1px ${tk.line}` : 'none',
              color: zero ? tk.mut : tk.fg,
            }}
          >
            <Box
              sx={{
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                fontSize: narrow || stats.length > 3 ? 12 : 12.5,
                minWidth: 0,
                opacity: zero ? 1 : 1,
              }}
            >
              <Box sx={{ display: 'flex', opacity: zero ? 0.5 : 1 }}>
                <StatusMark status={s.status} size={14} />
              </Box>
              <Box
                component="span"
                sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              >
                {s.label}
              </Box>
            </Box>
            <Box
              component="div"
              sx={{
                fontSize: size,
                lineHeight: 1,
                whiteSpace: 'nowrap',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {s.value}
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}
