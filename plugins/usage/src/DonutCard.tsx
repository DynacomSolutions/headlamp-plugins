/* One donut per resource; every group has its own slice, listed in a scrollable legend. */
import Box from '@mui/material/Box';
import ButtonBase from '@mui/material/ButtonBase';
import Chip from '@mui/material/Chip';
import Paper from '@mui/material/Paper';
import { useTheme } from '@mui/material/styles';
import Typography from '@mui/material/Typography';
import React from 'react';
import { Cell, Pie, PieChart, Tooltip } from 'recharts';
import { primaryFor } from './describe';
import { Slice } from './model';
import { ResourceDef } from './resources';
import { formatPercent } from './units';

const SIZE = 200;

export interface DonutCardProps {
  def: ResourceDef;
  slices: Slice[];
  total: number;
  windowSeconds: number;
  colourOf: (key: string) => string;
  /** Group name as shown (e.g. without the namespace prefix a drill-down implies). */
  nameOf: (key: string) => string;
  /** Keys that sit under their workload because they could not be placed. */
  fallbackKeys: Set<string>;
  /** Called with the group key when a slice or legend row is activated; undefined disables drilling. */
  onSelect?: (key: string) => void;
}

export function DonutCard({ def, slices, total, windowSeconds, colourOf, nameOf, fallbackKeys, onSelect }: DonutCardProps): JSX.Element {
  const theme = useTheme();
  const [hovered, setHovered] = React.useState<string | null>(null);
  const summary =
    slices.length === 0 ? `${def.label}: no usage` : `${def.label}: ${slices.slice(0, 5).map(s => `${nameOf(s.key)} ${formatPercent(s.value, total)}`).join(', ')}${slices.length > 5 ? `, and ${slices.length - 5} more` : ''}`;

  return (
    <Paper variant="outlined" sx={{ p: 2, minWidth: 'min(460px, 100%)', flex: '1 1 460px', maxWidth: '100%' }}>
      <Typography variant="subtitle1" component="h3">
        {def.label}
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
        Total {primaryFor(def, total, windowSeconds)} in {slices.length} groups
      </Typography>
      {slices.length === 0 ? (
        <Typography variant="body2" color="text.secondary" sx={{ py: 4 }}>
          No usage recorded for the current selection.
        </Typography>
      ) : (
        <>
          <Box sx={{ display: 'flex', justifyContent: 'center' }}>
            <div role="img" aria-label={summary} style={{ width: SIZE, height: SIZE }}>
              <PieChart width={SIZE} height={SIZE}>
                <Tooltip
                  content={({ active, payload }: any) => {
                    const s: Slice | undefined = active ? payload?.[0]?.payload : undefined;
                    return s ? (
                      <Paper variant="outlined" sx={{ p: 1, maxWidth: 280 }}>
                        <Typography variant="body2" sx={{ wordBreak: 'break-all' }}>
                          {nameOf(s.key)}
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                          {primaryFor(def, s.value, windowSeconds)} ({formatPercent(s.value, total)})
                        </Typography>
                      </Paper>
                    ) : null;
                  }}
                />
                <Pie
                  data={slices}
                  dataKey="value"
                  nameKey="key"
                  innerRadius={56}
                  outerRadius={92}
                  paddingAngle={0}
                  minAngle={0}
                  stroke={theme.palette.background.paper}
                  strokeWidth={1}
                  isAnimationActive={false}
                  onMouseEnter={(d: any) => setHovered(d?.key ?? d?.payload?.key ?? null)}
                  onMouseLeave={() => setHovered(null)}
                  onClick={(d: any) => {
                    const key = d?.key ?? d?.payload?.key;
                    if (onSelect && key) {
                      onSelect(key);
                    }
                  }}
                >
                  {slices.map(s => (
                    <Cell
                      key={s.key}
                      fill={colourOf(s.key)}
                      fillOpacity={hovered === null || hovered === s.key ? 1 : 0.35}
                      style={{ cursor: onSelect ? 'pointer' : 'default', outline: 'none' }}
                    />
                  ))}
                </Pie>
              </PieChart>
            </div>
          </Box>
          <Box component="ul" aria-label={`${def.label} groups`} sx={{ listStyle: 'none', m: 0, mt: 1, p: 0, maxHeight: 260, overflowY: 'auto' }}>
            {slices.map(s => (
              <li key={s.key}>
                <ButtonBase
                  disabled={!onSelect}
                  onClick={() => onSelect?.(s.key)}
                  onMouseEnter={() => setHovered(s.key)}
                  onMouseLeave={() => setHovered(null)}
                  onFocus={() => setHovered(s.key)}
                  onBlur={() => setHovered(null)}
                  title={s.key}
                  sx={{
                    display: 'flex',
                    width: '100%',
                    gap: 1,
                    py: 0.25,
                    px: 0.5,
                    textAlign: 'left',
                    justifyContent: 'flex-start',
                    borderRadius: 0.5,
                    bgcolor: hovered === s.key ? 'action.hover' : undefined,
                    '&.Mui-disabled': { pointerEvents: 'none' },
                  }}
                >
                  <Box component="span" sx={{ width: 12, height: 12, borderRadius: '2px', flex: '0 0 auto', bgcolor: colourOf(s.key) }} />
                  <Typography variant="body2" noWrap sx={{ flex: '1 1 auto', minWidth: 0 }}>
                    {nameOf(s.key)}
                  </Typography>
                  <Typography variant="body2" color="text.secondary" sx={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
                    {primaryFor(def, s.value, windowSeconds)} ({formatPercent(s.value, total)})
                  </Typography>
                  {fallbackKeys.has(s.key) && (
                    <Chip size="small" label="workload" variant="outlined" sx={{ height: 14, fontSize: 9, flex: '0 0 auto', '& .MuiChip-label': { px: 0.5 } }} />
                  )}
                </ButtonBase>
              </li>
            ))}
          </Box>
        </>
      )}
    </Paper>
  );
}
