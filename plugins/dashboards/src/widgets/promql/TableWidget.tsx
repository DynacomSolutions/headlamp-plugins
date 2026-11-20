import Box from '@mui/material/Box';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TableSortLabel from '@mui/material/TableSortLabel';
import React from 'react';
import type { WidgetDefinition, WidgetProps, WidgetSettingsProps } from '../../contract';
import { SettingsForm } from '../SettingsForm';
import { parseBlocks, QueryBlock } from './blocks';
import { kioskBox, Notice, useInk } from './common';
import { buildTableRows, parseVector, pickLabelColumns, TableRow as Row } from './mapping';
import { QueryEditor } from './QueryEditor';
import { formatValue, Unit, UNIT_OPTIONS } from './units';
import { useElementSize } from './useElementSize';
import { useQueries } from './useQueries';

export interface TableConfig {
  /** One or more queries, one value column each. Separate them with a line of `---`. */
  queries: string;
  /** Label columns, comma separated. Blank shows every label. */
  labels: string;
  /** The unit for value columns that do not set their own. */
  unit: Unit;
}

export const DEFAULT_TABLE: TableConfig = {
  queries:
    '# Memory | bytes\nsum by (namespace, pod) (container_memory_working_set_bytes{namespace=~"$namespace",container!=""})',
  labels: 'namespace, pod',
  unit: 'plain',
};

export interface SortState {
  /** Column index: 0..labels-1 are label columns, then the value columns. */
  column: number;
  dir: 'asc' | 'desc';
}

/** Sort rows by a column. Empty values go last in both directions. */
export function sortRows(rows: Row[], labelCount: number, sort: SortState): Row[] {
  const sign = sort.dir === 'asc' ? 1 : -1;
  const isLabel = sort.column < labelCount;
  return [...rows].sort((a, b) => {
    if (isLabel) {
      return (
        sign *
        a.cells[sort.column].localeCompare(b.cells[sort.column], undefined, {
          numeric: true,
          sensitivity: 'base',
        })
      );
    }
    const av = a.values[sort.column - labelCount];
    const bv = b.values[sort.column - labelCount];
    if (av === null && bv === null) return 0;
    if (av === null) return 1;
    if (bv === null) return -1;
    return sign * (av - bv);
  });
}

function TableWidget({
  config,
  filters,
  refreshSignal,
  reportRefreshed,
  kiosk,
}: WidgetProps<TableConfig>): JSX.Element {
  const { sizeRef } = useElementSize<HTMLDivElement>();
  const { ink } = useInk(kiosk);
  const blocks: QueryBlock[] = React.useMemo(() => parseBlocks(config.queries), [config.queries]);
  const queries = React.useMemo(() => blocks.map(b => b.query), [blocks]);
  const state = useQueries({
    mode: 'instant',
    queries,
    filters,
    refreshSignal,
    reportRefreshed,
    widthRef: sizeRef,
  });
  const [sort, setSort] = React.useState<SortState | null>(null);

  const samples = React.useMemo(
    () => state.results?.map(r => parseVector(r.result, undefined, r.resultType)),
    [state.results]
  );
  const columns = React.useMemo(
    () => (samples ? pickLabelColumns(samples.flat(), config.labels) : []),
    [samples, config.labels]
  );
  const rows = React.useMemo(
    () => (samples ? buildTableRows(samples, columns) : []),
    [samples, columns]
  );
  const active: SortState = sort ?? { column: columns.length, dir: 'desc' };
  const sorted = React.useMemo(
    () => sortRows(rows, columns.length, active),
    [rows, columns.length, active.column, active.dir]
  ); // eslint-disable-line react-hooks/exhaustive-deps
  const click = (column: number) =>
    setSort({
      column,
      dir:
        active.column === column && active.dir === 'desc'
          ? 'asc'
          : active.column === column
          ? 'desc'
          : column < columns.length
          ? 'asc'
          : 'desc',
    });

  if (state.error) return <Notice kind="error">{state.error}</Notice>;
  if (blocks.length === 0) return <Notice kind="empty">Set a query in the widget settings.</Notice>;
  if (!samples) return <Notice kind="wait">Loading...</Notice>;
  if (rows.length === 0) return <Notice kind="empty">The query returned no data.</Notice>;

  const head = (label: string, column: number, align: 'left' | 'right') => (
    <TableCell
      key={column}
      align={align}
      sortDirection={active.column === column ? active.dir : false}
      sx={{ bgcolor: ink.surface, color: ink.secondary, fontWeight: 600, whiteSpace: 'nowrap' }}
    >
      <TableSortLabel
        active={active.column === column}
        direction={active.column === column ? active.dir : 'asc'}
        onClick={() => click(column)}
        sx={{
          color: 'inherit !important',
          '& .MuiTableSortLabel-icon': { color: 'inherit !important' },
        }}
      >
        {label}
      </TableSortLabel>
    </TableCell>
  );

  return (
    <Box
      data-promql-table
      sx={{
        height: '100%',
        overflow: kiosk ? 'hidden' : 'auto',
        opacity: state.loading ? 0.6 : 1,
        transition: 'opacity 150ms',
        color: ink.primary,
        ...kioskBox(kiosk),
      }}
    >
      <Table size="small" stickyHeader>
        <TableHead>
          <TableRow>
            {columns.map((c, i) => head(c, i, 'left'))}
            {blocks.map((b, i) =>
              head(
                b.title || (blocks.length > 1 ? `Value ${i + 1}` : 'Value'),
                columns.length + i,
                'right'
              )
            )}
          </TableRow>
        </TableHead>
        <TableBody>
          {sorted.map(r => (
            <TableRow key={r.key}>
              {r.cells.map((c, i) => (
                <TableCell key={i} sx={{ color: ink.primary, overflowWrap: 'anywhere' }}>
                  {c}
                </TableCell>
              ))}
              {r.values.map((v, i) => (
                <TableCell
                  key={i}
                  align="right"
                  sx={{
                    color: ink.primary,
                    fontVariantNumeric: 'tabular-nums',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {v === null ? '-' : formatValue(v, blocks[i]?.unit ?? config.unit)}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Box>
  );
}

function TableSettings({ config, onChange }: WidgetSettingsProps<TableConfig>): JSX.Element {
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: 1 }}>
      <QueryEditor
        label="PromQL queries"
        multi
        value={config.queries}
        onChange={queries => onChange({ ...config, queries })}
        help="Each query is one value column. Put a line with --- between queries. A first line like '# Memory | bytes' names the column and sets its unit (plain, bytes, cores, percent, ratio or seconds). Rows join on the label columns."
      />
      <SettingsForm
        config={config}
        onChange={onChange}
        fields={[
          {
            key: 'labels',
            label: 'Label columns',
            type: 'text',
            help: 'Label names separated by commas, in the order to show. Blank shows every label.',
          },
          { key: 'unit', label: 'Default unit', type: 'select', options: UNIT_OPTIONS },
        ]}
      />
    </Box>
  );
}

export const tableWidget: WidgetDefinition<TableConfig> = {
  type: 'promql.table',
  title: 'Query table',
  description: 'One row for each series of a PromQL instant query, with sortable columns.',
  icon: 'mdi:table',
  category: 'Monitoring',
  defaultSize: { w: 6, h: 9 },
  minSize: { w: 3, h: 4 },
  defaultConfig: DEFAULT_TABLE,
  selfScroll: true,
  SettingsComponent: TableSettings,
  Component: TableWidget,
};
