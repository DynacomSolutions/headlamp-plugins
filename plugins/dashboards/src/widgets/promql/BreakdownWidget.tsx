import Box from '@mui/material/Box';
import React from 'react';
import type { WidgetDefinition, WidgetProps, WidgetSettingsProps } from '../../contract';
import { SettingsForm } from '../SettingsForm';
import { kioskBox, Notice, useColourBook, useInk } from './common';
import { Group, groupSamples, parseVector } from './mapping';
import { QueryEditor } from './QueryEditor';
import { slicePath } from './scale';
import { formatValue, Unit, UNIT_OPTIONS } from './units';
import { useElementSize } from './useElementSize';
import { useQueries } from './useQueries';

export interface BreakdownConfig {
  query: string;
  /** The label to group by. Blank groups by the whole series. */
  groupBy: string;
  view: 'donut' | 'bar';
  unit: Unit;
}

export const DEFAULT_BREAKDOWN: BreakdownConfig = {
  query:
    'sum by (namespace) (container_memory_working_set_bytes{namespace=~"$namespace",container!=""})',
  groupBy: 'namespace',
  view: 'donut',
  unit: 'bytes',
};

/** The share of the total as text. A share under 0.1 percent reads "<0.1%". */
export function formatShare(value: number, total: number): string {
  if (!(total > 0) || !(value > 0)) return '0%';
  const p = (100 * value) / total;
  if (p < 0.1) return '<0.1%';
  return `${p.toFixed(p >= 10 ? 0 : 1)}%`;
}

export interface Slice {
  group: Group;
  from: number;
  to: number;
}

/** The angles (radians from the top, clockwise) of each group with a positive value. Real sizes, no merging. */
export function sliceAngles(groups: Group[]): Slice[] {
  const total = groups.reduce((a, g) => a + Math.max(0, g.value), 0);
  if (!(total > 0)) return [];
  let angle = 0;
  const out: Slice[] = [];
  for (const g of groups) {
    if (!(g.value > 0)) continue;
    const to = angle + (g.value / total) * Math.PI * 2;
    out.push({ group: g, from: angle, to });
    angle = to;
  }
  return out;
}

function Donut(props: {
  groups: Group[];
  unit: Unit;
  colourFor: (k: string) => string;
  ink: ReturnType<typeof useInk>['ink'];
  size: number;
}): JSX.Element {
  const { groups, unit, colourFor, ink, size } = props;
  const [active, setActive] = React.useState<string | null>(null);
  const slices = React.useMemo(() => sliceAngles(groups), [groups]);
  const total = groups.reduce((a, g) => a + Math.max(0, g.value), 0);
  const shown = groups.find(g => g.key === active);
  const R = 90;
  const r = 58;
  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: size > 420 ? 'row' : 'column',
        gap: 1.5,
        height: '100%',
        minHeight: 0,
        alignItems: size > 420 ? 'center' : 'stretch',
      }}
    >
      <Box
        sx={{
          flex: size > 420 ? '0 0 45%' : '1 1 55%',
          minHeight: 0,
          minWidth: 0,
          display: 'flex',
          justifyContent: 'center',
        }}
      >
        <svg
          viewBox="0 0 200 200"
          role="img"
          aria-label="Share of each group"
          style={{ height: '100%', maxWidth: '100%', aspectRatio: '1' }}
          onPointerLeave={() => setActive(null)}
        >
          {slices.map(s => (
            <path
              key={s.group.key}
              d={slicePath(100, 100, R, r, s.from, s.to)}
              fill={colourFor(s.group.key)}
              stroke={ink.surface}
              strokeWidth={2}
              opacity={active && active !== s.group.key ? 0.55 : 1}
              onPointerEnter={() => setActive(s.group.key)}
              onPointerDown={() => setActive(s.group.key)}
              data-slice={s.group.name}
            >
              <title>{`${s.group.name}: ${formatValue(s.group.value, unit)} (${formatShare(
                s.group.value,
                total
              )})`}</title>
            </path>
          ))}
          <text
            x={100}
            y={shown ? 92 : 104}
            textAnchor="middle"
            fontSize={shown ? 11 : 13}
            fill={ink.secondary}
          >
            {shown
              ? shown.name.length > 18
                ? `${shown.name.slice(0, 17)}...`
                : shown.name
              : 'Total'}
          </text>
          <text
            x={100}
            y={shown ? 112 : 124}
            textAnchor="middle"
            fontSize={17}
            fontWeight={600}
            fill={ink.primary}
          >
            {formatValue(shown ? shown.value : total, unit)}
          </text>
        </svg>
      </Box>
      <Box
        role="list"
        aria-label="Groups"
        sx={{
          flex: '1 1 0',
          minHeight: 0,
          minWidth: 0,
          overflow: 'auto',
          fontSize: 12,
          ...kioskBox(false),
        }}
      >
        {groups.map(g => (
          <Box
            role="listitem"
            key={g.key}
            onPointerEnter={() => setActive(g.key)}
            onPointerLeave={() => setActive(null)}
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 0.75,
              py: '2px',
              opacity: active && active !== g.key ? 0.55 : 1,
            }}
          >
            <Box
              component="span"
              sx={{
                width: 10,
                height: 10,
                borderRadius: '2px',
                flex: 'none',
                bgcolor: colourFor(g.key),
              }}
            />
            <Box
              component="span"
              title={g.name}
              sx={{
                flex: '1 1 0',
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                color: ink.secondary,
              }}
            >
              {g.name}
            </Box>
            <Box
              component="span"
              sx={{ fontVariantNumeric: 'tabular-nums', color: ink.primary, fontWeight: 600 }}
            >
              {formatValue(g.value, unit)}
            </Box>
            <Box
              component="span"
              sx={{
                width: '4.5em',
                textAlign: 'right',
                fontVariantNumeric: 'tabular-nums',
                color: ink.secondary,
              }}
            >
              {formatShare(g.value, total)}
            </Box>
          </Box>
        ))}
      </Box>
    </Box>
  );
}

function Bars(props: {
  groups: Group[];
  unit: Unit;
  colour: string;
  ink: ReturnType<typeof useInk>['ink'];
}): JSX.Element {
  const { groups, unit, colour, ink } = props;
  const total = groups.reduce((a, g) => a + Math.max(0, g.value), 0);
  const max = Math.max(0, ...groups.map(g => g.value));
  return (
    <Box role="list" aria-label="Groups" sx={{ height: '100%', overflow: 'auto', fontSize: 12 }}>
      {groups.map(g => (
        <Box
          role="listitem"
          key={g.key}
          sx={{
            display: 'grid',
            gridTemplateColumns: 'minmax(5em, 30%) 1fr auto 4.5em',
            alignItems: 'center',
            gap: 1,
            py: '3px',
          }}
        >
          <Box
            title={g.name}
            sx={{
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              color: ink.secondary,
            }}
          >
            {g.name}
          </Box>
          <Box sx={{ height: 12, bgcolor: ink.track, borderRadius: '0 4px 4px 0' }}>
            <Box
              data-bar={g.name}
              sx={{
                height: '100%',
                width: `${max > 0 && g.value > 0 ? (g.value / max) * 100 : 0}%`,
                bgcolor: colour,
                borderRadius: '0 4px 4px 0',
              }}
            />
          </Box>
          <Box
            sx={{
              fontVariantNumeric: 'tabular-nums',
              color: ink.primary,
              fontWeight: 600,
              textAlign: 'right',
            }}
          >
            {formatValue(g.value, unit)}
          </Box>
          <Box
            sx={{ fontVariantNumeric: 'tabular-nums', color: ink.secondary, textAlign: 'right' }}
          >
            {formatShare(g.value, total)}
          </Box>
        </Box>
      ))}
    </Box>
  );
}

function BreakdownWidget({
  config,
  filters,
  refreshSignal,
  reportRefreshed,
  kiosk,
}: WidgetProps<BreakdownConfig>): JSX.Element {
  const { ref, size, sizeRef } = useElementSize<HTMLDivElement>();
  const { ink, mode } = useInk(kiosk);
  const book = useColourBook();
  const queries = React.useMemo(() => [config.query.trim()], [config.query]);
  const state = useQueries({
    mode: 'instant',
    queries,
    filters,
    refreshSignal,
    reportRefreshed,
    widthRef: sizeRef,
  });
  const groups = React.useMemo(() => {
    const r = state.results?.[0];
    return r
      ? groupSamples(parseVector(r.result, undefined, r.resultType), config.groupBy)
      : undefined;
  }, [state.results, config.groupBy]);
  const colourFor = React.useCallback((key: string) => book.colour(key, mode), [book, mode]);
  groups?.forEach(g => colourFor(g.key));
  const unit = UNIT_OPTIONS.some(o => o.value === config.unit) ? config.unit : 'plain';

  let body: React.ReactNode;
  if (state.error) body = <Notice kind="error">{state.error}</Notice>;
  else if (queries[0] === '')
    body = <Notice kind="empty">Set a query in the widget settings.</Notice>;
  else if (!groups) body = <Notice kind="wait">Loading...</Notice>;
  else if (groups.length === 0) body = <Notice kind="empty">The query returned no data.</Notice>;
  else if (config.view === 'bar')
    body = (
      <Bars
        groups={groups}
        unit={unit}
        colour={mode === 'dark' ? '#3987e5' : '#2a78d6'}
        ink={ink}
      />
    );
  else
    body = <Donut groups={groups} unit={unit} colourFor={colourFor} ink={ink} size={size.width} />;

  return (
    <Box
      ref={ref}
      sx={{
        height: '100%',
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

function BreakdownSettings({
  config,
  onChange,
}: WidgetSettingsProps<BreakdownConfig>): JSX.Element {
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: 1 }}>
      <QueryEditor
        label="PromQL query"
        value={config.query}
        onChange={query => onChange({ ...config, query })}
        help="An instant query. Variables: $namespace, $node, $range, $step, $rate and $selector."
      />
      <SettingsForm
        config={config}
        onChange={onChange}
        fields={[
          {
            key: 'groupBy',
            label: 'Group by label',
            type: 'text',
            help: 'Each value of this label is one slice or bar. Series with the same value add up. Blank groups by the whole series.',
          },
          {
            key: 'view',
            label: 'Chart type',
            type: 'select',
            options: [
              { value: 'donut', label: 'Pie (donut)' },
              { value: 'bar', label: 'Bars' },
            ],
          },
          { key: 'unit', label: 'Unit', type: 'select', options: UNIT_OPTIONS },
        ]}
      />
    </Box>
  );
}

export const breakdownWidget: WidgetDefinition<BreakdownConfig> = {
  type: 'promql.breakdown',
  title: 'Breakdown',
  description:
    'A pie or bar chart of a PromQL instant query, grouped by a label. Every group is shown.',
  icon: 'mdi:chart-pie',
  category: 'Monitoring',
  defaultSize: { w: 5, h: 9 },
  minSize: { w: 3, h: 5 },
  defaultConfig: DEFAULT_BREAKDOWN,
  selfScroll: true,
  SettingsComponent: BreakdownSettings,
  Component: BreakdownWidget,
};
