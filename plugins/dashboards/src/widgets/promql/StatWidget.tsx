import Box from '@mui/material/Box';
import React from 'react';
import type { WidgetDefinition, WidgetProps, WidgetSettingsProps } from '../../contract';
import { SettingsForm } from '../SettingsForm';
import { kioskBox, Notice, useInk } from './common';
import { LevelBadge } from './LevelBadge';
import {
  mergeTimes,
  parseMatrix,
  parseVector,
  Reduce,
  REDUCE_OPTIONS,
  reduceSamples,
  Series,
  valueAt,
} from './mapping';
import { QueryEditor } from './QueryEditor';
import { Sparkline } from './Sparkline';
import { LEVEL_COLOUR, parseThresholds, thresholdLevel } from './thresholds';
import { formatValue, Unit, UNIT_OPTIONS } from './units';
import { useElementSize } from './useElementSize';
import { useQueries } from './useQueries';

export interface StatConfig {
  query: string;
  unit: Unit;
  reduce: Reduce;
  label: string;
  sparkline: boolean;
  thresholds: string;
  /** A lower value is worse (free space, for example). */
  invert: boolean;
}

export const DEFAULT_STAT: StatConfig = {
  query: 'count(kube_pod_info{namespace=~"$namespace"})',
  unit: 'plain',
  reduce: 'first',
  label: 'Pods',
  sparkline: true,
  thresholds: '',
  invert: false,
};

/** Combine several series into one, time by time. */
export function reduceSeries(series: Series[], how: Reduce): Series {
  const times = mergeTimes(series);
  return {
    key: 'reduced',
    labels: {},
    name: '',
    points: times.map(t => ({
      t,
      v: reduceSamples(
        series.map(s => valueAt(s, t)),
        how
      ),
    })),
  };
}

/** The value to show, and the points of the sparkline when there are any. */
export function statValue(
  results: Array<{ resultType: string; result: unknown }> | undefined,
  config: Pick<StatConfig, 'sparkline' | 'reduce'>
): { value: number | null; spark: Array<number | null> } | undefined {
  const r = results?.[0];
  if (!r) return undefined;
  if (config.sparkline) {
    const series = parseMatrix(r.result);
    if (series.length === 0) return { value: null, spark: [] };
    const one = series.length === 1 ? series[0] : reduceSeries(series, config.reduce);
    const spark = one.points.map(p => p.v);
    let last: number | null = null;
    for (const v of spark) if (v !== null) last = v;
    return { value: last, spark };
  }
  const samples = parseVector(r.result, undefined, r.resultType);
  return {
    value: reduceSamples(
      samples.map(s => s.value),
      config.reduce
    ),
    spark: [],
  };
}

function StatWidget({
  config,
  filters,
  refreshSignal,
  reportRefreshed,
  kiosk,
}: WidgetProps<StatConfig>): JSX.Element {
  const { ref, sizeRef, measured } = useElementSize<HTMLDivElement>();
  const { ink, mode } = useInk(kiosk);
  const queries = React.useMemo(() => [config.query.trim()], [config.query]);
  const state = useQueries({
    mode: config.sparkline ? 'range' : 'instant',
    queries,
    filters,
    refreshSignal,
    reportRefreshed,
    widthRef: sizeRef,
    enabled: !config.sparkline || measured,
  });
  const data = React.useMemo(() => statValue(state.results, config), [state.results, config]);
  const steps = React.useMemo(() => parseThresholds(config.thresholds), [config.thresholds]);
  const level =
    data && data.value !== null ? thresholdLevel(data.value, steps, config.invert) : undefined;
  const accent = level ? LEVEL_COLOUR[level] : mode === 'dark' ? '#3987e5' : '#2a78d6';
  const unit = UNIT_OPTIONS.some(o => o.value === config.unit) ? config.unit : 'plain';

  let body: React.ReactNode;
  if (state.error) body = <Notice kind="error">{state.error}</Notice>;
  else if (queries[0] === '')
    body = <Notice kind="empty">Set a query in the widget settings.</Notice>;
  else if (!data) body = <Notice kind="wait">Loading...</Notice>;
  else if (data.value === null) body = <Notice kind="empty">The query returned no value.</Notice>;
  else {
    body = (
      <Box
        sx={{
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: 0,
        }}
      >
        {config.label && (
          <Box
            sx={{
              color: ink.secondary,
              fontSize: 'clamp(0.75rem, 6cqmin, 1.2rem)',
              textAlign: 'center',
              maxWidth: '100%',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {config.label}
          </Box>
        )}
        <Box
          data-stat-value
          sx={{
            fontSize: 'clamp(1.6rem, 24cqmin, 6rem)',
            fontWeight: 600,
            lineHeight: 1.1,
            color: ink.primary,
            maxWidth: '100%',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {formatValue(data.value, unit)}
        </Box>
        {level && <LevelBadge level={level} color={ink.secondary} />}
        {config.sparkline && data.spark.length > 1 && (
          <Box sx={{ width: '100%', flex: '0 1 30%', minHeight: 24, maxHeight: 80, mt: 1 }}>
            <Sparkline
              values={data.spark}
              colour={accent}
              label={`${config.label || 'Value'} over the time range`}
            />
          </Box>
        )}
      </Box>
    );
  }

  return (
    <Box
      ref={ref}
      sx={{
        height: '100%',
        containerType: 'size',
        opacity: state.loading ? 0.6 : 1,
        transition: 'opacity 150ms',
        color: ink.primary,
        ...kioskBox(kiosk),
      }}
    >
      {body}
    </Box>
  );
}

function StatSettings({ config, onChange }: WidgetSettingsProps<StatConfig>): JSX.Element {
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: 1 }}>
      <QueryEditor
        label="PromQL query"
        value={config.query}
        onChange={query => onChange({ ...config, query })}
        help="Variables: $namespace, $node, $range, $step, $rate and $selector."
      />
      <SettingsForm
        config={config}
        onChange={onChange}
        fields={[
          { key: 'label', label: 'Label', type: 'text' },
          { key: 'unit', label: 'Unit', type: 'select', options: UNIT_OPTIONS },
          {
            key: 'reduce',
            label: 'When the query returns several series',
            type: 'select',
            options: REDUCE_OPTIONS,
          },
          {
            key: 'sparkline',
            label: 'Show a sparkline (uses the dashboard time range)',
            type: 'boolean',
          },
          {
            key: 'thresholds',
            label: 'Thresholds',
            type: 'text',
            placeholder: '70:warning, 90:critical',
            help: 'From a value up, the status changes: good, warning, serious or critical. Below the first one the status is good.',
          },
          {
            key: 'invert',
            label: 'A lower value is worse (thresholds read as "or less")',
            type: 'boolean',
          },
        ]}
      />
    </Box>
  );
}

export const statWidget: WidgetDefinition<StatConfig> = {
  type: 'promql.stat',
  title: 'Stat tile',
  description: 'One value from a PromQL query, with an optional sparkline and thresholds.',
  icon: 'mdi:numeric',
  category: 'Monitoring',
  defaultSize: { w: 3, h: 5 },
  minSize: { w: 2, h: 3 },
  defaultConfig: DEFAULT_STAT,
  SettingsComponent: StatSettings,
  Component: StatWidget,
};
