/*
 * Draws a PanelModel: the status and summary, stats as tiles, rows as a table with fraction bars
 * and links, series as sparklines and rings as sunbursts. Pure rendering, so it is easy to test.
 * Status is never colour alone: each status has its own shape and its own word.
 */
import Box from '@mui/material/Box';
import { useTheme } from '@mui/material/styles';
import Typography from '@mui/material/Typography';
import React from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { SunburstChart } from '../sunburst/SunburstChart';
import {
  isEmptyPanel,
  PanelModel,
  PanelRing,
  PanelRow,
  PanelStatus,
  ringToSunburst,
} from './model';
import { PanelBars } from './PanelBars';
import { PanelTables } from './PanelTables';
import { Sparkline } from './Sparkline';
import { STATUS_WORD, StatusMark, useStatusColours } from './StatusMark';

export { STATUS_WORD, StatusMark, useStatusColours };

function Label(props: { row: PanelRow; editing: boolean }): JSX.Element {
  const { row, editing } = props;
  const link = row.link;
  if (!link || editing) return <>{row.label}</>;
  return link.startsWith('/') ? (
    <RouterLink to={link} style={{ color: 'inherit' }}>
      {row.label}
    </RouterLink>
  ) : (
    <a href={link} target="_blank" rel="noopener noreferrer" style={{ color: 'inherit' }}>
      {row.label}
    </a>
  );
}

function FractionBar(props: { fraction: number; status: PanelStatus }): JSX.Element {
  const colours = useStatusColours();
  const theme = useTheme();
  const track = theme.palette.mode === 'dark' ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.10)';
  return (
    <Box
      role="img"
      aria-label={`${Math.round(props.fraction * 100)} percent`}
      sx={{ height: 6, borderRadius: '3px', bgcolor: track, overflow: 'hidden', minWidth: 48 }}
    >
      <Box
        data-fraction={props.fraction}
        sx={{
          height: '100%',
          width: `${props.fraction * 100}%`,
          bgcolor: colours[props.status === 'unknown' ? 'ok' : props.status],
        }}
      />
    </Box>
  );
}

export const ringFormat =
  (ring: PanelRing) =>
  (v: number): string => {
    if (ring.unit === 'cores') return `${v >= 100 ? v.toFixed(0) : v.toFixed(2)} cores`;
    if (ring.unit === 'bytes') {
      const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
      let n = v;
      let i = 0;
      while (n >= 1024 && i < units.length - 1) {
        n /= 1024;
        i++;
      }
      return `${n.toFixed(i === 0 || n >= 100 ? 0 : n >= 10 ? 1 : 2)} ${units[i]}`;
    }
    return `${v}`;
  };

/** How the rows draw: a table (`list`) or one bar per label with a segment per row (`grouped-bars`). */
export type RowLayout = 'list' | 'grouped-bars';
export const ROW_LAYOUTS: ReadonlyArray<RowLayout> = ['list', 'grouped-bars'];

export interface PanelDisplay {
  /** The status line with the summary. Default on. */
  showSummary: boolean;
  /** The stat tiles. Default on. */
  showStats: boolean;
  rowLayout: RowLayout;
}

export const DEFAULT_DISPLAY: PanelDisplay = {
  showSummary: true,
  showStats: true,
  rowLayout: 'list',
};

/** Reads the display options of a saved widget config. A missing or wrong value gets its default. */
export function displayOf(config: {
  showSummary?: unknown;
  showStats?: unknown;
  rowLayout?: unknown;
}): PanelDisplay {
  return {
    showSummary: config.showSummary !== false,
    showStats: config.showStats !== false,
    rowLayout: config.rowLayout === 'grouped-bars' ? 'grouped-bars' : 'list',
  };
}

export interface PanelViewProps {
  panel: PanelModel;
  kiosk: boolean;
  editing: boolean;
  display?: PanelDisplay;
}

export function PanelView({
  panel,
  kiosk,
  editing,
  display = DEFAULT_DISPLAY,
}: PanelViewProps): JSX.Element {
  const withBar = panel.rows.some(r => r.fraction !== undefined);
  if (isEmptyPanel(panel)) {
    return (
      <Box data-panel-empty sx={{ p: 1 }}>
        <Typography variant="body2" color="text.secondary">
          This panel has nothing to show right now.
        </Typography>
      </Box>
    );
  }
  return (
    <Box
      data-panel={panel.id}
      sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, minWidth: 0 }}
    >
      {display.showSummary && (panel.summary || panel.status !== 'unknown') && (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <StatusMark status={panel.status} size={14} />
          <Typography variant="body2" data-panel-summary sx={{ fontWeight: 500 }}>
            {panel.summary || STATUS_WORD[panel.status]}
          </Typography>
        </Box>
      )}
      {display.showStats && panel.stats.length > 0 && (
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(84px, 1fr))',
            gap: 1,
          }}
        >
          {panel.stats.map((s, i) => (
            <Box
              key={`${s.label}-${i}`}
              data-stat
              sx={{
                border: 1,
                borderColor: 'divider',
                borderRadius: 1,
                px: 1,
                py: 0.75,
                minWidth: 0,
                bgcolor: kiosk ? 'transparent' : undefined,
              }}
            >
              <Typography variant="caption" color="text.secondary" noWrap component="div">
                {s.label}
              </Typography>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                <StatusMark status={s.status} size={10} />
                <Typography
                  variant="h6"
                  component="div"
                  sx={{ lineHeight: 1.2, fontVariantNumeric: 'tabular-nums' }}
                >
                  {s.value}
                </Typography>
              </Box>
            </Box>
          ))}
        </Box>
      )}
      {panel.rings.length > 0 && (
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 2, justifyContent: 'center' }}>
          {panel.rings.map(ring => (
            <Box key={ring.id} data-ring={ring.id} sx={{ width: 'min(320px, 100%)', height: 300 }}>
              <SunburstChart
                data={ringToSunburst(ring)}
                title={ring.label}
                format={ringFormat(ring)}
                kiosk={kiosk}
              />
            </Box>
          ))}
        </Box>
      )}
      {panel.series.length > 0 && (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
          {panel.series.map((s, i) => (
            <Box
              key={`${s.label}-${i}`}
              data-series
              sx={{
                display: 'grid',
                gridTemplateColumns: 'minmax(60px, 30%) 1fr',
                alignItems: 'center',
                gap: 1,
              }}
            >
              <Typography variant="caption" color="text.secondary" noWrap>
                {s.label}
              </Typography>
              <Sparkline label={s.label} points={s.points} />
            </Box>
          ))}
        </Box>
      )}
      {panel.rows.length > 0 && display.rowLayout === 'grouped-bars' && (
        <PanelBars rows={panel.rows} kiosk={kiosk} editing={editing} />
      )}
      {panel.rows.length > 0 && display.rowLayout === 'list' && (
        <Box
          component="table"
          data-rows
          sx={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8125rem' }}
        >
          <tbody>
            {panel.rows.map((r, i) => (
              <Box
                component="tr"
                key={`${r.label}-${i}`}
                data-row
                sx={{ borderTop: i === 0 ? 0 : 1, borderColor: 'divider' }}
              >
                <Box component="td" sx={{ py: 0.5, pr: 1, width: 18 }}>
                  <StatusMark status={r.status} size={10} />
                </Box>
                <Box component="td" sx={{ py: 0.5, pr: 1, maxWidth: 220 }}>
                  <Typography variant="body2" noWrap title={r.label}>
                    <Label row={r} editing={editing} />
                  </Typography>
                  {r.detail && (
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      noWrap
                      component="div"
                      title={r.detail}
                    >
                      {r.detail}
                    </Typography>
                  )}
                </Box>
                {withBar && (
                  <Box component="td" sx={{ py: 0.5, pr: 1, width: '28%' }}>
                    {r.fraction !== undefined && (
                      <FractionBar fraction={r.fraction} status={r.status} />
                    )}
                  </Box>
                )}
                <Box
                  component="td"
                  sx={{
                    py: 0.5,
                    textAlign: 'right',
                    whiteSpace: 'nowrap',
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {r.value}
                </Box>
              </Box>
            ))}
          </tbody>
        </Box>
      )}
      {panel.tables.length > 0 && <PanelTables tables={panel.tables} />}
    </Box>
  );
}
