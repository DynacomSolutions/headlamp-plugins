import Box from '@mui/material/Box';
import React from 'react';
import type { WidgetDefinition, WidgetProps, WidgetSettingsProps } from '../../contract';
import { useReportStale } from '../../resilience/stale';
import { SettingsForm } from '../SettingsForm';
import { kioskBox, Notice, useInk } from './common';
import { LevelBadge } from './LevelBadge';
import { parseVector, Reduce, REDUCE_OPTIONS, reduceSamples } from './mapping';
import { QueryEditor } from './QueryEditor';
import { LEVEL_COLOUR, parseThresholds, thresholdLevel, ThresholdStep } from './thresholds';
import { formatValue, parseOptionalNumber, Unit, UNIT_OPTIONS } from './units';
import { useElementSize } from './useElementSize';
import { useQueries } from './useQueries';

export interface GaugeConfig {
  query: string;
  unit: Unit;
  reduce: Reduce;
  label: string;
  min: string;
  max: string;
  thresholds: string;
  invert: boolean;
}

export const DEFAULT_GAUGE: GaugeConfig = {
  query: '100 * (1 - avg(rate(node_cpu_seconds_total{mode="idle"}[$rate])))',
  unit: 'percent',
  reduce: 'first',
  label: 'CPU',
  min: '0',
  max: '100',
  thresholds: '70:warning, 90:critical',
  invert: false,
};

/** The share of the scale that a value fills, between 0 and 1. */
export function gaugeFraction(value: number, min: number, max: number): number {
  if (!(max > min) || !Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, (value - min) / (max - min)));
}

const CX = 100;
const CY = 100;
const R = 78;
const W = 16;

/** A point on the half circle: fraction 0 is the left end, 1 the right end. */
export function arcPoint(fraction: number, r = R): [number, number] {
  const a = Math.PI * (1 - fraction);
  return [CX + r * Math.cos(a), CY - r * Math.sin(a)];
}

export function arcPath(from: number, to: number, r = R): string {
  const [x0, y0] = arcPoint(from, r);
  const [x1, y1] = arcPoint(to, r);
  const large = to - from > 0.5 ? 1 : 0;
  return `M${x0.toFixed(2)},${y0.toFixed(2)}A${r},${r} 0 ${large} 1 ${x1.toFixed(2)},${y1.toFixed(
    2
  )}`;
}

function GaugeWidget({
  config,
  filters,
  refreshSignal,
  reportRefreshed,
  kiosk,
  cache,
}: WidgetProps<GaugeConfig>): JSX.Element {
  const { ref, sizeRef } = useElementSize<HTMLDivElement>();
  const { ink } = useInk(kiosk);
  const queries = React.useMemo(() => [config.query.trim()], [config.query]);
  const state = useQueries({
    mode: 'instant',
    queries,
    filters,
    refreshSignal,
    reportRefreshed,
    widthRef: sizeRef,
    cache,
  });
  useReportStale(state.staleSince, !!state.cached && !state.error);
  const value = React.useMemo(() => {
    const r = state.results?.[0];
    return r
      ? reduceSamples(
          parseVector(r.result, undefined, r.resultType).map(s => s.value),
          config.reduce
        )
      : undefined;
  }, [state.results, config.reduce]);
  const steps = React.useMemo(() => parseThresholds(config.thresholds), [config.thresholds]);
  const min = parseOptionalNumber(config.min) ?? 0;
  const max = parseOptionalNumber(config.max) ?? 100;
  const unit = UNIT_OPTIONS.some(o => o.value === config.unit) ? config.unit : 'plain';
  const level = typeof value === 'number' ? thresholdLevel(value, steps, config.invert) : undefined;
  const fill = level ? LEVEL_COLOUR[level] : '#3987e5';

  let body: React.ReactNode;
  if (state.error && !state.results) body = <Notice kind="error">{state.error}</Notice>;
  else if (queries[0] === '')
    body = <Notice kind="empty">Set a query in the widget settings.</Notice>;
  else if (value === undefined) body = <Notice kind="wait">Loading...</Notice>;
  else if (value === null) body = <Notice kind="empty">The query returned no value.</Notice>;
  else {
    const frac = gaugeFraction(value, min, max);
    body = (
      <Box
        sx={{
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          minHeight: 0,
        }}
      >
        <svg
          role="img"
          aria-label={`${config.label || 'Gauge'}: ${formatValue(value, unit)}, scale ${formatValue(
            min,
            unit
          )} to ${formatValue(max, unit)}`}
          viewBox="0 0 200 120"
          style={{ flex: '1 1 0', minHeight: 0, width: '100%' }}
        >
          <path d={arcPath(0, 1)} fill="none" stroke={ink.track} strokeWidth={W} />
          {frac > 0 && (
            <path data-gauge-value d={arcPath(0, frac)} fill="none" stroke={fill} strokeWidth={W} />
          )}
          {steps.map((s: ThresholdStep) => {
            const f = gaugeFraction(s.value, min, max);
            if (f <= 0 || f >= 1) return null;
            const [x0, y0] = arcPoint(f, R - W / 2 - 2);
            const [x1, y1] = arcPoint(f, R + W / 2 + 2);
            return (
              <line
                key={`${s.value}-${s.level}`}
                x1={x0}
                y1={y0}
                x2={x1}
                y2={y1}
                stroke={ink.surface}
                strokeWidth={2}
              />
            );
          })}
          <text x={CX - R} y={CY + 14} textAnchor="middle" fontSize={9} fill={ink.muted}>
            {formatValue(min, unit, { compact: true })}
          </text>
          <text x={CX + R} y={CY + 14} textAnchor="middle" fontSize={9} fill={ink.muted}>
            {formatValue(max, unit, { compact: true })}
          </text>
          <text
            x={CX}
            y={CY - 6}
            textAnchor="middle"
            fontSize={26}
            fontWeight={600}
            fill={ink.primary}
          >
            {formatValue(value, unit)}
          </text>
        </svg>
        <Box
          sx={{
            flex: 'none',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            pb: 0.5,
          }}
        >
          {config.label && (
            <Box sx={{ color: ink.secondary, fontSize: 'clamp(0.75rem, 5cqmin, 1.1rem)' }}>
              {config.label}
            </Box>
          )}
          {level && <LevelBadge level={level} color={ink.secondary} />}
        </Box>
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
        ...kioskBox(kiosk),
      }}
    >
      {body}
    </Box>
  );
}

function GaugeSettings({ config, onChange }: WidgetSettingsProps<GaugeConfig>): JSX.Element {
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
          { key: 'min', label: 'Scale minimum', type: 'text' },
          { key: 'max', label: 'Scale maximum', type: 'text' },
          {
            key: 'reduce',
            label: 'When the query returns several series',
            type: 'select',
            options: REDUCE_OPTIONS,
          },
          {
            key: 'thresholds',
            label: 'Thresholds',
            type: 'text',
            placeholder: '70:warning, 90:critical',
            help: 'Values on the scale, for example 70:warning, 90:critical. Below the first one the status is good.',
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

export const gaugeWidget: WidgetDefinition<GaugeConfig> = {
  type: 'promql.gauge',
  title: 'Gauge',
  description: 'One PromQL value against a maximum, with thresholds.',
  icon: 'mdi:gauge',
  category: 'Monitoring',
  defaultSize: { w: 3, h: 6 },
  minSize: { w: 2, h: 4 },
  defaultConfig: DEFAULT_GAUGE,
  SettingsComponent: GaugeSettings,
  Component: GaugeWidget,
};
