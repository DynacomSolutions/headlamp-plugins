/*
 * The matrix widget: rows by columns, one cell for each pair, from PromQL instant queries. It was
 * built for the loss of a ping between two nodes. Every pair has a cell. A pair with no sample shows
 * "no data" (a dash on a hatched cell), never 0. A cell above a limit shows a shape (a triangle for
 * a warning, a square for critical) next to its value, so colour is never the only cue. The summary
 * line sits in the footer of the widget frame and never scrolls.
 */
import Box from '@mui/material/Box';
import React from 'react';
import type { WidgetDefinition, WidgetProps, WidgetSettingsProps } from '../../contract';
import { useReportStale } from '../../resilience/stale';
import { WidgetFooter } from '../footer';
import { StatusMark } from '../panels/StatusMark';
import { useTokens } from '../panels/tokens';
import { SettingsForm } from '../SettingsForm';
import { kioskBox, Notice, thinScroll, useInk } from './common';
import { parseVector } from './mapping';
import { buildMatrix, MatrixCell, MatrixModel, summaryText } from './matrix';
import { QueryEditor } from './QueryEditor';
import { formatValue, Unit, UNIT_OPTIONS } from './units';
import { useElementSize } from './useElementSize';
import { useQueries } from './useQueries';

export interface MatrixConfig {
  /** The value of each pair, as an instant query with the row and the column label. */
  query: string;
  /** Optional: 1 for a direct path, 0 for a relayed one. A relayed pair gets a mark. */
  directQuery: string;
  /** Optional: the round trip time in seconds. It goes in the tooltip. */
  rttQuery: string;
  rowLabel: string;
  columnLabel: string;
  /** Rows and columns are one set of members and the diagonal is blank. */
  sameSet: boolean;
  /** A value above this is a warning. */
  warnAbove: number;
  /** A value above this is critical (a pair "above the limit"). */
  critAbove: number;
  unit: Unit;
}

export const DEFAULT_MATRIX: MatrixConfig = {
  query: 'max by (source, target) (avg_over_time(ping_loss_ratio[5m]))',
  directQuery: 'max by (source, target) (ping_direct)',
  rttQuery: 'max by (source, target) (ping_rtt_seconds)',
  rowLabel: 'source',
  columnLabel: 'target',
  sameSet: true,
  warnAbove: 0,
  critAbove: 0.02,
  unit: 'ratio',
};

const num = (v: unknown, fallback: number) =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;

/** The text of a cell tooltip and of its accessible name. */
export function cellTitle(c: MatrixCell, unit: Unit): string {
  const parts = [`${c.row} to ${c.col}`, c.value === null ? 'no data' : formatValue(c.value, unit)];
  if (c.rtt !== null) parts.push(`round trip ${formatValue(c.rtt, 'seconds')}`);
  if (c.direct !== null) parts.push(c.direct ? 'direct path' : 'relayed path');
  return parts.join(', ');
}

const HATCH = (line: string) =>
  `repeating-linear-gradient(135deg, transparent 0 4px, ${line} 4px 5px)`;

function Cell({
  cell,
  unit,
  fill,
  hatch,
  fg,
  muted,
}: {
  cell: MatrixCell;
  unit: Unit;
  fill: string;
  hatch: string;
  fg: string;
  muted: string;
}): JSX.Element {
  const noData = cell.status === 'unknown';
  const title = cellTitle(cell, unit);
  return (
    <Box
      role="cell"
      title={title}
      aria-label={title}
      data-matrix-cell
      data-status={cell.status}
      data-row={cell.row}
      data-col={cell.col}
      data-direct={cell.direct === null ? undefined : String(cell.direct)}
      sx={{
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '3px',
        minWidth: 0,
        borderRadius: '4px',
        bgcolor: fill,
        backgroundImage: noData ? HATCH(hatch) : undefined,
        color: noData ? muted : fg,
        fontSize: 13,
        fontWeight: cell.status === 'crit' ? 700 : 500,
        fontVariantNumeric: 'tabular-nums',
        whiteSpace: 'nowrap',
      }}
    >
      {(cell.status === 'warn' || cell.status === 'crit') && (
        <StatusMark status={cell.status} size={9} />
      )}
      <span>{noData || cell.value === null ? '-' : formatValue(cell.value, unit)}</span>
      {cell.direct === false && (
        <Box
          component="span"
          data-matrix-relayed
          sx={{
            position: 'absolute',
            top: 1,
            right: 3,
            fontSize: 9,
            lineHeight: 1,
            fontWeight: 700,
            color: muted,
          }}
        >
          R
        </Box>
      )}
    </Box>
  );
}

/** The grid of the matrix. It is exported for tests. */
export function MatrixGrid({
  model,
  unit,
  kiosk,
}: {
  model: MatrixModel;
  unit: Unit;
  kiosk: boolean;
}): JSX.Element {
  const { ink, mode } = useInk(kiosk);
  const t = useTokens();
  const { rows, cols } = model;
  const head = {
    color: ink.secondary,
    fontSize: 12,
    fontWeight: 600,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    display: 'flex',
    alignItems: 'center',
    // The header cells stay opaque, so the cells scroll under them. They take the colour of the card.
    bgcolor: kiosk && mode === 'dark' ? ink.surface : 'background.paper',
    position: 'sticky',
  } as const;
  return (
    <Box
      role="table"
      data-matrix-grid
      sx={{
        flex: 1,
        minHeight: 0,
        overflow: 'auto',
        ...thinScroll,
        display: 'grid',
        gridTemplateColumns: `minmax(36px, max-content) repeat(${cols.length}, minmax(46px, 1fr))`,
        gridTemplateRows: `auto repeat(${rows.length}, minmax(26px, 1fr))`,
        gap: '3px',
        alignContent: 'stretch',
      }}
    >
      <Box sx={{ ...head, top: 0, left: 0, zIndex: 2 }} />
      {cols.map(c => (
        <Box
          key={c}
          role="columnheader"
          title={c}
          sx={{ ...head, top: 0, zIndex: 1, justifyContent: 'center' }}
        >
          {c}
        </Box>
      ))}
      {rows.map(r => (
        <React.Fragment key={r}>
          <Box role="rowheader" title={r} sx={{ ...head, left: 0, zIndex: 1, pr: 1 }}>
            {r}
          </Box>
          {cols.map(c => {
            const cell = model.cell(r, c);
            if (!cell)
              return (
                <Box
                  key={c}
                  role="cell"
                  aria-hidden
                  data-matrix-diagonal
                  sx={{ borderRadius: '4px', bgcolor: t.hover, opacity: 0.5 }}
                />
              );
            return (
              <Cell
                key={c}
                cell={cell}
                unit={unit}
                fill={cell.status === 'ok' ? 'transparent' : t.fill[cell.status]}
                hatch={t.line2}
                fg={ink.primary}
                muted={ink.muted}
              />
            );
          })}
        </React.Fragment>
      ))}
    </Box>
  );
}

function MatrixWidget({
  config,
  filters,
  refreshSignal,
  reportRefreshed,
  kiosk,
  footer,
  cache,
}: WidgetProps<MatrixConfig>): JSX.Element {
  const { sizeRef } = useElementSize<HTMLDivElement>();
  const { ink } = useInk(kiosk);
  const unit: Unit = UNIT_OPTIONS.some(o => o.value === config.unit) ? config.unit : 'ratio';
  const queries = React.useMemo(
    () => [config.query, config.directQuery, config.rttQuery].map(q => (q ?? '').trim()),
    [config.query, config.directQuery, config.rttQuery]
  );
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
  const options = {
    rowLabel: config.rowLabel || 'source',
    columnLabel: config.columnLabel || 'target',
    sameSet: config.sameSet !== false,
    warnAbove: num(config.warnAbove, 0),
    critAbove: num(config.critAbove, 0.02),
    unit,
  };
  const { rowLabel, columnLabel, sameSet, warnAbove, critAbove } = options;
  const model = React.useMemo(() => {
    if (!state.results) return undefined;
    const [value, direct, rtt] = state.results.map(r =>
      parseVector(r.result, undefined, r.resultType)
    );
    return buildMatrix(value ?? [], direct ?? [], rtt ?? [], {
      rowLabel,
      columnLabel,
      sameSet,
      warnAbove,
      critAbove,
      unit,
    });
  }, [state.results, rowLabel, columnLabel, sameSet, warnAbove, critAbove, unit]);

  if (state.error && !state.results) return <Notice kind="error">{state.error}</Notice>;
  if (queries[0] === '') return <Notice kind="empty">Set a query in the widget settings.</Notice>;
  if (!model) return <Notice kind="wait">Loading...</Notice>;
  if (model.rows.length === 0 && model.cols.length === 0)
    return <Notice kind="empty">The query returned no data.</Notice>;

  const { summary } = model;
  return (
    <Box
      data-promql-matrix
      data-status={model.status}
      sx={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        opacity: state.loading ? 0.6 : 1,
        transition: 'opacity 150ms',
        color: ink.primary,
        ...kioskBox(kiosk),
      }}
    >
      <MatrixGrid model={model} unit={unit} kiosk={kiosk} />
      {(summary.relayed > 0 || summary.noData > 0) && (
        <Box
          data-matrix-key
          sx={{ display: 'flex', gap: 1.5, fontSize: 11, color: ink.muted, flex: 'none' }}
        >
          {summary.relayed > 0 && <span>R relayed path</span>}
          {summary.noData > 0 && <span>- no data</span>}
        </Box>
      )}
      <WidgetFooter status={model.status} footer={footer}>
        <span data-matrix-summary>{summaryText(summary, options)}</span>
      </WidgetFooter>
    </Box>
  );
}

function MatrixSettings({ config, onChange }: WidgetSettingsProps<MatrixConfig>): JSX.Element {
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: 1 }}>
      <QueryEditor
        label="Value query"
        value={config.query}
        onChange={query => onChange({ ...config, query })}
        help="An instant query with the row label and the column label, one series for each pair."
      />
      <QueryEditor
        label="Path query (optional)"
        value={config.directQuery}
        onChange={directQuery => onChange({ ...config, directQuery })}
        help="1 for a direct path, 0 for a relayed path. A relayed pair gets an R mark."
      />
      <QueryEditor
        label="Round trip query (optional)"
        value={config.rttQuery}
        onChange={rttQuery => onChange({ ...config, rttQuery })}
        help="Seconds for each pair. It shows in the tooltip of the cell."
      />
      <SettingsForm
        config={config}
        onChange={onChange}
        fields={[
          { key: 'rowLabel', label: 'Row label', type: 'text' },
          { key: 'columnLabel', label: 'Column label', type: 'text' },
          {
            key: 'sameSet',
            label: 'Rows and columns are the same members (blank diagonal)',
            type: 'boolean',
          },
          {
            key: 'warnAbove',
            label: 'Warning above',
            type: 'number',
            step: 0.001,
            help: 'In the unit of the query: 0 marks any loss when the unit is ratio.',
          },
          {
            key: 'critAbove',
            label: 'Critical above',
            type: 'number',
            step: 0.001,
            help: 'In the unit of the query: 0.02 is 2% when the unit is ratio.',
          },
          { key: 'unit', label: 'Unit', type: 'select', options: UNIT_OPTIONS },
        ]}
      />
    </Box>
  );
}

export const matrixWidget: WidgetDefinition<MatrixConfig> = {
  type: 'promql.matrix',
  title: 'Query matrix',
  description:
    'A rows by columns matrix of a PromQL instant query, for example ping loss between nodes. A pair with no data shows as no data.',
  icon: 'mdi:grid',
  category: 'Monitoring',
  defaultSize: { w: 4, h: 8 },
  minSize: { w: 3, h: 5 },
  defaultConfig: DEFAULT_MATRIX,
  selfScroll: true,
  SettingsComponent: MatrixSettings,
  Component: MatrixWidget,
};
