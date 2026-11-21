/*
 * Draws a PanelModel: the status and summary, stats as tiles, rows as a table with fraction bars
 * and links, series as sparklines and rings as sunbursts. Pure rendering, so it is easy to test.
 * Status is never colour alone: each status has its own shape and its own word.
 */
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import React from 'react';
import { WidgetFooter } from '../footer';
import { useElementSize } from '../promql/useElementSize';
import { SunburstChart } from '../sunburst/SunburstChart';
import { isEmptyPanel, PanelModel, PanelRing, ringToSunburst } from './model';
import { PanelBars } from './PanelBars';
import { PanelLanes } from './PanelLanes';
import { PanelTables } from './PanelTables';
import { okWordOf, RowList } from './RowList';
import { SeriesPlot, useSeriesColours } from './SeriesPlot';
import type { PanelSource } from './sources';
import { Sparkline } from './Sparkline';
import { StatTiles } from './StatTiles';
import { STATUS_WORD, StatusMark, useStatusColours } from './StatusMark';

export { STATUS_WORD, StatusMark, useStatusColours };

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

/**
 * How the rows draw: a table (`list`), one bar per label with a segment per row (`grouped-bars`),
 * or one bar per label split into a lane per limit (`stacked-lanes`).
 */
export type RowLayout = 'list' | 'grouped-bars' | 'stacked-lanes';
export const ROW_LAYOUTS: ReadonlyArray<RowLayout> = ['list', 'grouped-bars', 'stacked-lanes'];

export interface PanelDisplay {
  /** The status line with the summary. Default on. */
  showSummary: boolean;
  /** The stat tiles. Default on. */
  showStats: boolean;
  rowLayout: RowLayout;
  /** A limit line for the series plot, when the series has none of its own. 0 or missing: none. */
  seriesLimit?: number;
  /** The unit that the plot shows after its numbers, for example `s`. */
  seriesUnit?: string;
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
  seriesLimit?: unknown;
  seriesUnit?: unknown;
}): PanelDisplay {
  const limit =
    typeof config.seriesLimit === 'number' && config.seriesLimit > 0
      ? config.seriesLimit
      : undefined;
  const unit = typeof config.seriesUnit === 'string' ? config.seriesUnit.trim().slice(0, 8) : '';
  return {
    ...(limit !== undefined ? { seriesLimit: limit } : {}),
    ...(unit !== '' ? { seriesUnit: unit } : {}),
    showSummary: config.showSummary !== false,
    showStats: config.showStats !== false,
    rowLayout:
      config.rowLayout === 'grouped-bars' || config.rowLayout === 'stacked-lanes'
        ? config.rowLayout
        : 'list',
  };
}

export interface PanelViewProps {
  panel: PanelModel;
  kiosk: boolean;
  editing: boolean;
  display?: PanelDisplay;
  /** The source of the panel. Row icons are fetched through it. Without it no icon shows. */
  source?: PanelSource;
}

export function PanelView({
  panel,
  kiosk,
  editing,
  display = DEFAULT_DISPLAY,
  source,
}: PanelViewProps): JSX.Element {
  const seriesColour = useSeriesColours();
  const root = useElementSize<HTMLDivElement>();
  const rowsBox = useElementSize<HTMLDivElement>();
  // The rows fit the height of the widget (and show "+N more") when the list is the last block
  // and nothing else needs the height. Other layouts keep their own height and the widget scrolls.
  const fitted =
    (display.rowLayout === 'list' || display.rowLayout === 'stacked-lanes') &&
    panel.rings.length === 0 &&
    panel.tables.length === 0;
  const hasSeries = panel.series.length > 0;
  const plotWidth = root.size.width;
  const plotHeight = Math.max(90, Math.min(220, Math.round(root.size.height * 0.42)));
  const sharedPlot = hasSeries && plotWidth > 0 && root.size.height > 0;
  if (isEmptyPanel(panel)) {
    return (
      <Box data-panel-empty sx={{ p: 1 }}>
        <Typography variant="body2" color="text.secondary">
          This panel has nothing to show right now.
        </Typography>
      </Box>
    );
  }
  // One colour for each series, matched to its row by the label.
  const swatch = sharedPlot
    ? (r: { label: string }) => {
        const i = panel.series.findIndex(s => s.label === r.label);
        return i >= 0 ? seriesColour(i) : undefined;
      }
    : undefined;
  return (
    <Box
      ref={root.ref}
      data-panel={panel.id}
      sx={{
        display: 'flex',
        flexDirection: 'column',
        gap: 1.25,
        minWidth: 0,
        ...(fitted ? { height: '100%', minHeight: 0, overflow: 'hidden' } : {}),
      }}
    >
      {display.showStats && panel.stats.length > 0 && (
        <StatTiles stats={panel.stats} width={root.size.width} />
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
      {hasSeries &&
        (sharedPlot ? (
          <SeriesPlot
            series={panel.series.map(s => ({
              ...s,
              limit: s.limit ?? display.seriesLimit,
              unit: s.unit ?? display.seriesUnit,
            }))}
            width={plotWidth}
            height={plotHeight}
          />
        ) : (
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
        ))}
      {panel.rows.length > 0 && display.rowLayout === 'grouped-bars' && (
        <PanelBars rows={panel.rows} kiosk={kiosk} editing={editing} source={source} />
      )}
      {panel.rows.length > 0 && display.rowLayout === 'stacked-lanes' && (
        <Box sx={fitted ? { flex: '1 1 0', minHeight: 0, overflow: 'hidden' } : { minWidth: 0 }}>
          <PanelLanes rows={panel.rows} kiosk={kiosk} editing={editing} source={source} />
        </Box>
      )}
      {panel.rows.length > 0 && display.rowLayout === 'list' && (
        <Box
          ref={rowsBox.ref}
          sx={fitted ? { flex: '1 1 0', minHeight: 0, overflow: 'hidden' } : { minWidth: 0 }}
        >
          <RowList
            rows={panel.rows}
            okWord={okWordOf(panel.id)}
            height={fitted ? rowsBox.size.height : 0}
            width={rowsBox.size.width}
            editing={editing}
            source={source}
            swatch={swatch}
          />
        </Box>
      )}
      {panel.tables.length > 0 && <PanelTables tables={panel.tables} />}
      {display.showSummary && (panel.summary || panel.status !== 'unknown') && (
        // The summary sits in the footer line of the widget frame, in one size and one weight.
        <WidgetFooter status={panel.status}>
          <span data-panel-summary>{panel.summary || STATUS_WORD[panel.status]}</span>
        </WidgetFooter>
      )}
    </Box>
  );
}
