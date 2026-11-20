import Box from '@mui/material/Box';
import ButtonBase from '@mui/material/ButtonBase';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import React from 'react';
import type { WidgetDefinition, WidgetProps, WidgetSettingsProps } from '../../contract';
import { SettingsForm } from '../SettingsForm';
import { parseBlocks } from './blocks';
import { kioskBox, Notice, useColourBook, useInk } from './common';
import { parseMatrix, Series, seriesStats } from './mapping';
import { QueryEditor } from './QueryEditor';
import { ChartKind, TimeSeriesView } from './TimeSeriesView';
import { formatValue, parseOptionalNumber, Unit, UNIT_OPTIONS } from './units';
import { useElementSize } from './useElementSize';
import { useQueries } from './useQueries';

export interface TimeSeriesConfig {
  /** One or more queries. A line with only `---` separates them. A first line `# legend` names the series. */
  queries: string;
  kind: ChartKind;
  unit: Unit;
  yMin: string;
  yMax: string;
  legend: boolean;
}

export const DEFAULT_TIMESERIES: TimeSeriesConfig = {
  queries: 'sum by (namespace) (rate(container_cpu_usage_seconds_total{namespace=~"$namespace"}[$rate]))',
  kind: 'line',
  unit: 'cores',
  yMin: '',
  yMax: '',
  legend: true,
};

/** The series of all query results. With several queries the key carries the query number. */
export function collectSeries(results: Array<{ result: unknown }> | undefined, legends: string[]): Series[] {
  if (!results) return [];
  const many = results.length > 1;
  return results.flatMap((r, qi) =>
    parseMatrix(r.result, legends[qi]).map(s => (many ? { ...s, key: `${qi}:${s.key}` } : s))
  );
}

function TimeSeriesWidget({ config, filters, refreshSignal, reportRefreshed, kiosk }: WidgetProps<TimeSeriesConfig>): JSX.Element {
  const { ref, size, sizeRef, measured } = useElementSize<HTMLDivElement>();
  const { ink, mode } = useInk(kiosk);
  const book = useColourBook();
  const blocks = React.useMemo(() => parseBlocks(config.queries), [config.queries]);
  const queries = React.useMemo(() => blocks.map(b => b.query), [blocks]);
  const state = useQueries({ mode: 'range', queries, filters, refreshSignal, reportRefreshed, widthRef: sizeRef, enabled: measured });
  const [hidden, setHidden] = React.useState<ReadonlySet<string>>(new Set());
  const [table, setTable] = React.useState(false);

  const series = React.useMemo(
    () => collectSeries(state.results, blocks.map(b => b.title)),
    [state.results, blocks]
  );
  // Give each series its colour in order of first sight, so a colour stays with its series.
  const colourFor = React.useCallback((key: string) => book.colour(key, mode), [book, mode]);
  series.forEach(s => colourFor(s.key));
  const visible = React.useMemo(() => series.filter(s => !hidden.has(s.key)), [series, hidden]);
  const toggle = (key: string) =>
    setHidden(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const unit = UNIT_OPTIONS.some(o => o.value === config.unit) ? config.unit : 'plain';
  const showLegend = config.legend && series.length > 1;
  const swatchIsLine = config.kind === 'line';
  const hasData = series.some(s => s.points.some(p => p.v !== null));
  const tz = state.end !== undefined ? -new Date(state.end * 1000).getTimezoneOffset() * 60 : 0;

  let body: React.ReactNode;
  if (state.error) body = <Notice kind="error">{state.error}</Notice>;
  else if (queries.every(q => q === '')) body = <Notice kind="empty">Set a query in the widget settings.</Notice>;
  else if (!state.results) body = <Notice kind="wait">Loading...</Notice>;
  else if (!hasData) body = <Notice kind="empty">The query returned no data.</Notice>;
  else if (table) {
    body = (
      <Box sx={{ height: '100%', overflow: 'auto' }}>
        <Table size="small" stickyHeader aria-label="Series values">
          <TableHead>
            <TableRow>
              {['Series', 'Last', 'Min', 'Average', 'Max'].map((h, i) => (
                <TableCell key={h} align={i === 0 ? 'left' : 'right'} sx={{ bgcolor: ink.surface, color: ink.secondary }}>
                  {h}
                </TableCell>
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {series.map(s => {
              const st = seriesStats(s);
              return (
                <TableRow key={s.key}>
                  <TableCell sx={{ color: ink.primary, overflowWrap: 'anywhere' }}>{s.name}</TableCell>
                  {[st.last, st.min, st.avg, st.max].map((v, i) => (
                    <TableCell key={i} align="right" sx={{ color: ink.primary, fontVariantNumeric: 'tabular-nums' }}>
                      {v === null ? '-' : formatValue(v, unit)}
                    </TableCell>
                  ))}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </Box>
    );
  } else if (size.width > 0 && size.height > 0 && state.start !== undefined && state.end !== undefined) {
    body = (
      <TimeSeriesView
        series={visible}
        kind={config.kind}
        unit={unit}
        yMin={parseOptionalNumber(config.yMin)}
        yMax={parseOptionalNumber(config.yMax)}
        start={state.start}
        end={state.end}
        width={size.width}
        height={size.height}
        colourFor={colourFor}
        ink={ink}
        kiosk={kiosk}
        tzOffsetSeconds={tz}
      />
    );
  }

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0, color: ink.primary, ...kioskBox(kiosk) }}>
      <Box ref={ref} sx={{ flex: '1 1 0', minHeight: 0, position: 'relative', opacity: state.loading ? 0.6 : 1, transition: 'opacity 150ms' }}>
        <Box sx={{ position: 'absolute', inset: 0 }}>{body}</Box>
      </Box>
      {(showLegend || (!kiosk && hasData)) && (
        <Box sx={{ flex: 'none', display: 'flex', alignItems: 'flex-start', gap: 1, pt: 0.5, maxHeight: '30%' }}>
          <Box role="group" aria-label="Legend" sx={{ flex: '1 1 0', display: 'flex', flexWrap: 'wrap', gap: '2px 12px', overflow: 'auto', maxHeight: 'inherit', ...kioskBox(kiosk) }}>
            {showLegend &&
              series.map(s => (
                <ButtonBase
                  key={s.key}
                  onClick={() => toggle(s.key)}
                  aria-pressed={!hidden.has(s.key)}
                  title={s.name}
                  sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75, fontSize: 12, color: ink.secondary, opacity: hidden.has(s.key) ? 0.4 : 1, textAlign: 'left', maxWidth: '100%', py: 0.25 }}
                >
                  <Box component="span" sx={{ width: swatchIsLine ? 12 : 10, height: swatchIsLine ? 2 : 10, flex: 'none', bgcolor: colourFor(s.key), borderRadius: swatchIsLine ? 0 : '2px' }} />
                  <Box component="span" sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {s.name}
                  </Box>
                </ButtonBase>
              ))}
          </Box>
          {!kiosk && hasData && (
            <ButtonBase onClick={() => setTable(t => !t)} aria-pressed={table} sx={{ flex: 'none', fontSize: 12, color: ink.secondary, textDecoration: 'underline', py: 0.25 }}>
              {table ? 'Show chart' : 'Show table'}
            </ButtonBase>
          )}
        </Box>
      )}
    </Box>
  );
}

function TimeSeriesSettings({ config, onChange }: WidgetSettingsProps<TimeSeriesConfig>): JSX.Element {
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: 1 }}>
      <QueryEditor
        label="PromQL queries"
        multi
        value={config.queries}
        onChange={queries => onChange({ ...config, queries })}
        help="Variables: $namespace, $node, $range, $step, $rate and $selector. To add a query, put a line with --- between them. A first line like '# {{pod}}' sets the series name from labels."
      />
      <SettingsForm
        config={config}
        onChange={onChange}
        fields={[
          {
            key: 'kind',
            label: 'Chart type',
            type: 'select',
            options: [
              { value: 'line', label: 'Line' },
              { value: 'area', label: 'Area' },
              { value: 'stacked', label: 'Stacked area' },
              { value: 'bar', label: 'Bars (stacked when there are several series)' },
            ],
          },
          { key: 'unit', label: 'Unit', type: 'select', options: UNIT_OPTIONS },
          { key: 'yMin', label: 'Y axis minimum', type: 'text', help: 'A number. Blank means automatic.' },
          { key: 'yMax', label: 'Y axis maximum', type: 'text', help: 'A number. Blank means automatic.' },
          { key: 'legend', label: 'Show the legend', type: 'boolean' },
        ]}
      />
    </Box>
  );
}

export const timeSeriesWidget: WidgetDefinition<TimeSeriesConfig> = {
  type: 'promql.timeseries',
  title: 'Time series chart',
  description: 'A PromQL range query as a line, area, stacked area or bar chart.',
  icon: 'mdi:chart-line',
  category: 'Monitoring',
  defaultSize: { w: 6, h: 9 },
  minSize: { w: 3, h: 5 },
  defaultConfig: DEFAULT_TIMESERIES,
  SettingsComponent: TimeSeriesSettings,
  Component: TimeSeriesWidget,
};
