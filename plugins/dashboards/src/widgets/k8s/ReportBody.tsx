/*
 * The report itself: a toolbar, an optional chart and one table (tabular, summary or matrix).
 * It renders from a list of objects and does no fetching, so the settings preview can reuse it.
 */
import { Icon } from '@iconify/react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import React from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { chartData } from './chart';
import type { ReportConfig } from './config';
import { GridColumn, GridLine, GridSort, GridTable } from './GridTable';
import { resourceLink } from './links';
import {
  buildReport,
  fieldHeader,
  flattenSummary,
  formatNumber,
  Group,
  MatrixReport,
  NONE_LABEL,
  Report,
  reportToCsv,
  RowView,
  ScopeFilters,
  SummaryReport,
  TabularReport,
} from './model';
import { ReportChart } from './ReportChart';
import { useReportColors } from './theme';

/** The current time, refreshed once a minute, so ages move without a refetch. */
function useMinute(): number {
  const [now, setNow] = React.useState(() => Math.floor(Date.now() / 60000) * 60000);
  React.useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 60000) * 60000), 60000);
    return () => clearInterval(t);
  }, []);
  return now;
}

export function downloadCsv(csv: string, name: string): void {
  const url = URL.createObjectURL(new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function fileName(config: ReportConfig): string {
  return `${config.source.plural}-${config.reportType}.csv`.replace(/[^a-z0-9._-]/gi, '_');
}

export interface ReportBodyProps {
  objects: any[];
  config: ReportConfig;
  scope: ScopeFilters;
  kiosk: boolean;
  editing: boolean;
  loading?: boolean;
  error?: string | null;
  /** Compact mode for the settings preview: no export, smaller chart. */
  preview?: boolean;
}

export function ReportBody(props: ReportBodyProps): JSX.Element {
  const { objects, config, scope, kiosk, editing, loading, error, preview } = props;
  const colors = useReportColors(kiosk);
  const now = useMinute();
  const [sort, setSort] = React.useState<GridSort | null>(null);
  const [toggled, setToggled] = React.useState<ReadonlySet<string>>(new Set());

  // The sort is a view option. A saved default applies until the user clicks a header.
  const sortField = sort ? sort.id : config.sortField;
  const sortDir = sort ? sort.dir : config.sortDir;
  const report: Report = React.useMemo(
    () => buildReport(objects, config, { now, scope, sortField, sortDir }),
    [objects, config, now, scope, sortField, sortDir]
  );
  const onSort = React.useCallback(
    (id: string) => setSort(s => (s && s.id === id ? { id, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { id, dir: 'asc' })),
    []
  );
  const toggle = React.useCallback(
    (id: string) =>
      setToggled(prev => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
    []
  );

  const count = report.type === 'tabular' ? report.rows.length : report.type === 'summary' ? report.total.count : report.grandTotal;
  const rowHeight = kiosk ? 40 : 32;
  const hasChart = report.type === 'summary' && config.chart !== 'none' && report.groups.length > 0;
  const data = React.useMemo(
    () => (report.type === 'summary' && config.chart !== 'none' ? chartData(report, config.chart, config.chartMeasure) : null),
    [report, config.chart, config.chartMeasure]
  );

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0, color: colors.text, bgcolor: kiosk ? colors.surface : undefined }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1.25, py: 0.5, color: colors.muted, fontSize: '0.75rem', minHeight: 28 }}>
        <span>
          {config.source.kind}
          {report.type === 'matrix' ? '' : `: ${count ?? 0} ${count === 1 ? 'row' : 'rows'}`}
          {loading ? ' (loading)' : ''}
        </span>
        <Box sx={{ flex: 1 }} />
        {!kiosk && !preview && (
          <Button
            size="small"
            startIcon={<Icon icon="mdi:download" width={16} />}
            sx={{ color: colors.muted, minWidth: 0 }}
            onClick={() => downloadCsv(reportToCsv(report, config), fileName(config))}
          >
            CSV
          </Button>
        )}
      </Box>
      {error && (
        <Alert severity="error" sx={{ mx: 1, mb: 0.5 }}>
          {error}
        </Alert>
      )}
      {report.logicError && (
        <Alert severity="warning" sx={{ mx: 1, mb: 0.5 }}>
          The filter logic is not valid, so all filters apply with AND. {report.logicError}
        </Alert>
      )}
      {hasChart && data && (
        <Box sx={{ height: preview ? 160 : '42%', minHeight: 140, px: 1, pb: 0.5, flex: 'none' }}>
          <ReportChart type={config.chart} data={data} colors={colors} />
        </Box>
      )}
      {report.type === 'tabular' && (
        <TabularTable report={report} config={config} sort={sort ?? (config.sortField ? { id: config.sortField, dir: config.sortDir } : null)} onSort={onSort} rowHeight={rowHeight} kiosk={kiosk} editing={editing} />
      )}
      {report.type === 'summary' && (
        <SummaryTable report={report} config={config} toggled={toggled} onToggle={toggle} sort={sort} onSort={onSort} rowHeight={rowHeight} kiosk={kiosk} editing={editing} />
      )}
      {report.type === 'matrix' && <MatrixTable report={report} config={config} rowHeight={rowHeight} kiosk={kiosk} />}
    </Box>
  );
}

/* ----------------------------------- cells ----------------------------------- */

function CellLink(props: { row: RowView; config: ReportConfig; children: React.ReactNode; editing: boolean; color: string }): JSX.Element {
  const { row, config, children, editing, color } = props;
  const to = editing ? null : resourceLink(row.obj, config.source);
  if (!to) return <>{children}</>;
  return (
    <RouterLink to={to} style={{ color, textDecoration: 'none', fontWeight: 500 }}>
      {children}
    </RouterLink>
  );
}

function rowCells(row: RowView, report: { columns: Array<{ field: string }> }, config: ReportConfig, editing: boolean, color: string): React.ReactNode[] {
  const linkColumn = Math.max(0, report.columns.findIndex(c => c.field === 'name'));
  return row.cells.map((cell, i) => {
    const text = <span title={cell.text}>{cell.text}</span>;
    return i === linkColumn ? (
      <CellLink key={i} row={row} config={config} editing={editing} color={color}>
        {text}
      </CellLink>
    ) : (
      text
    );
  });
}

function isNumericField(report: { rows?: RowView[] }, i: number): boolean {
  const first = report.rows?.find(r => r.cells[i].value !== null);
  return first ? typeof first.cells[i].value === 'number' : false;
}

/* ---------------------------------- tabular ---------------------------------- */

function TabularTable(props: {
  report: TabularReport;
  config: ReportConfig;
  sort: GridSort | null;
  onSort: (id: string) => void;
  rowHeight: number;
  kiosk: boolean;
  editing: boolean;
}): JSX.Element {
  const { report, config, sort, onSort, rowHeight, kiosk, editing } = props;
  const colors = useReportColors(kiosk);
  const columns: GridColumn[] = report.columns.map((c, i) => ({
    id: c.field,
    header: c.header,
    sortable: true,
    numeric: isNumericField(report, i),
    grow: c.field === 'name' ? 2 : c.field === 'labels' ? 3 : 1,
    min: c.field === 'name' ? 160 : 100,
  }));
  const getLine = React.useCallback(
    (i: number): GridLine => {
      const row = report.rows[i];
      return { key: row.key, kind: 'row', cells: rowCells(row, report, config, editing, colors.link) };
    },
    [report, config, editing, colors.link]
  );
  return <GridTable columns={columns} count={report.rows.length} getLine={getLine} sort={sort} onSort={onSort} rowHeight={rowHeight} colors={colors} kiosk={kiosk} label={`${config.source.kind} report`} />;
}

/* ----------------------------------- summary ----------------------------------- */

function aggText(report: SummaryReport, aggs: Array<number | null>): string {
  return report.aggregates.map((a, i) => `${a.header}: ${formatNumber(aggs[i]) || '-'}`).join('   ');
}

function SummaryTable(props: {
  report: SummaryReport;
  config: ReportConfig;
  toggled: ReadonlySet<string>;
  onToggle: (id: string) => void;
  sort: GridSort | null;
  onSort: (id: string) => void;
  rowHeight: number;
  kiosk: boolean;
  editing: boolean;
}): JSX.Element {
  const { report, config, toggled, onToggle, sort, onSort, rowHeight, kiosk, editing } = props;
  const colors = useReportColors(kiosk);
  const items = React.useMemo(() => flattenSummary(report, toggled, config.expandGroups, config.showRows), [report, toggled, config.expandGroups, config.showRows]);
  const withRows = config.showRows;
  const groupHeader = report.groupFields.map(f => fieldHeader(config, f)).join(' / ');

  const columns: GridColumn[] = withRows
    ? report.columns.map(c => ({ id: c.field, header: c.header, sortable: true, grow: c.field === 'name' ? 2 : 1, min: c.field === 'name' ? 160 : 100 }))
    : [
        { id: '#group', header: groupHeader, grow: 3, min: 180 },
        { id: '#rows', header: 'Rows', numeric: true, min: 70 },
        ...report.aggregates.map((a, i) => ({ id: `#agg${i}`, header: a.header, numeric: true, min: 120 })),
      ];

  const chevron = (open: boolean, hasBody: boolean) => (
    <Icon icon={open ? 'mdi:chevron-down' : 'mdi:chevron-right'} width={18} style={{ verticalAlign: 'middle', opacity: hasBody ? 1 : 0.25 }} aria-hidden />
  );
  const groupLabel = (g: Group, open: boolean, hasBody: boolean) => (
    <span style={{ paddingLeft: g.depth * 18 }}>
      {chevron(open, hasBody)}{' '}
      {withRows ? `${fieldHeader(config, g.field)}: ` : ''}
      {g.label === NONE_LABEL ? <em>{g.label}</em> : g.label}
    </span>
  );

  const getLine = React.useCallback(
    (i: number): GridLine => {
      const item = items[i];
      if (item.kind === 'row') {
        return { key: `r:${item.row.key}`, kind: 'row', cells: rowCells(item.row, report, config, editing, colors.link) };
      }
      if (item.kind === 'total') {
        return withRows
          ? { key: 'total', kind: 'total', band: <Box sx={{ px: 1.25 }}>{`Grand total: ${item.total.count} rows   ${aggText(report, item.total.aggs)}`}</Box> }
          : { key: 'total', kind: 'total', cells: ['Grand total', String(item.total.count), ...item.total.aggs.map(formatNumber)] };
      }
      const g = item.group;
      const toggle = item.hasBody ? () => onToggle(g.id) : undefined;
      return withRows
        ? {
            key: `g:${g.id}`,
            kind: 'group',
            expanded: item.hasBody ? item.open : undefined,
            onClick: toggle,
            band: (
              <Box sx={{ px: 1.25, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {groupLabel(g, item.open, item.hasBody)}
                <span style={{ color: colors.muted, fontWeight: 400 }}>{`   ${g.count} rows   ${aggText(report, g.aggs)}`}</span>
              </Box>
            ),
          }
        : {
            key: `g:${g.id}`,
            kind: 'group',
            expanded: item.hasBody ? item.open : undefined,
            onClick: toggle,
            cells: [groupLabel(g, item.open, item.hasBody), String(g.count), ...g.aggs.map(formatNumber)],
          };
    },
    [items, withRows, report, config, editing, colors.link, colors.muted, onToggle]
  );
  return <GridTable columns={columns} count={items.length} getLine={getLine} sort={withRows ? sort : null} onSort={withRows ? onSort : undefined} rowHeight={rowHeight} colors={colors} kiosk={kiosk} label={`${config.source.kind} summary report`} />;
}

/* ----------------------------------- matrix ----------------------------------- */

function MatrixTable(props: { report: MatrixReport; config: ReportConfig; rowHeight: number; kiosk: boolean }): JSX.Element {
  const { report, config, rowHeight, kiosk } = props;
  const colors = useReportColors(kiosk);
  const columns: GridColumn[] = [
    { id: '#row', header: `${fieldHeader(config, report.rowField)} / ${fieldHeader(config, report.colField)}`, grow: 2, min: 160 },
    ...report.colLabels.map((c, i) => ({ id: `c${i}`, header: c, numeric: true, min: 90 })),
    { id: '#total', header: 'Total', numeric: true, min: 90 },
  ];
  const getLine = React.useCallback(
    (i: number): GridLine => {
      if (i === report.rowLabels.length) {
        return { key: 'total', kind: 'matrix-total', cells: ['Total', ...report.colTotals.map(formatNumber), formatNumber(report.grandTotal)] };
      }
      return { key: `r:${report.rowLabels[i]}`, kind: 'row', cells: [report.rowLabels[i], ...report.cells[i].map(formatNumber), formatNumber(report.rowTotals[i])] };
    },
    [report]
  );
  return (
    <GridTable
      columns={columns}
      count={report.rowLabels.length > 0 ? report.rowLabels.length + 1 : 0}
      getLine={getLine}
      rowHeight={rowHeight}
      colors={colors}
      kiosk={kiosk}
      label={`${config.source.kind} matrix report, ${report.measure}`}
    />
  );
}
