/* The optional `tables` field of a panel: each table is sortable by clicking a column heading. */
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import React from 'react';
import { PanelTable, SortDir, sortTableRows } from './model';

function SortableTable({ table }: { table: PanelTable }): JSX.Element {
  const [sort, setSort] = React.useState<{ key: string; dir: SortDir } | null>(null);
  const rows = React.useMemo(
    () => (sort ? sortTableRows(table.rows, sort.key, sort.dir) : table.rows),
    [table.rows, sort]
  );
  // A sort on a column the table no longer has is ignored.
  const active = sort && table.columns.some(c => c.key === sort.key) ? sort : null;
  const onSort = (key: string) =>
    setSort(prev =>
      prev?.key === key ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }
    );
  return (
    <Box data-table sx={{ minWidth: 0, overflowX: 'auto' }}>
      {table.title && (
        <Typography variant="subtitle2" component="div" sx={{ mb: 0.5 }}>
          {table.title}
        </Typography>
      )}
      <Box
        component="table"
        sx={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8125rem' }}
      >
        <thead>
          <tr>
            {table.columns.map(c => {
              const isActive = active?.key === c.key;
              return (
                <Box
                  component="th"
                  key={c.key}
                  scope="col"
                  aria-sort={
                    isActive ? (active.dir === 'asc' ? 'ascending' : 'descending') : 'none'
                  }
                  sx={{
                    textAlign: c.align,
                    py: 0.5,
                    px: 0.75,
                    borderBottom: 1,
                    borderColor: 'divider',
                    fontWeight: 600,
                    whiteSpace: 'nowrap',
                  }}
                >
                  <Box
                    component="button"
                    type="button"
                    data-sort={c.key}
                    onClick={() => onSort(c.key)}
                    sx={{
                      all: 'unset',
                      cursor: 'pointer',
                      '&:focus-visible': { outline: '2px solid currentColor', outlineOffset: 2 },
                    }}
                  >
                    {c.label}
                    {isActive ? (active.dir === 'asc' ? ' ▲' : ' ▼') : ''}
                  </Box>
                </Box>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <Box
              component="tr"
              key={i}
              data-table-row
              sx={{ borderTop: i === 0 ? 0 : 1, borderColor: 'divider' }}
            >
              {table.columns.map(c => (
                <Box
                  component="td"
                  key={c.key}
                  sx={{
                    py: 0.5,
                    px: 0.75,
                    textAlign: c.align,
                    fontVariantNumeric: c.align === 'right' ? 'tabular-nums' : undefined,
                    whiteSpace: c.align === 'right' ? 'nowrap' : undefined,
                  }}
                >
                  {r[c.key]}
                </Box>
              ))}
            </Box>
          ))}
        </tbody>
      </Box>
    </Box>
  );
}

export function PanelTables({ tables }: { tables: PanelTable[] }): JSX.Element {
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
      {tables.map((t, i) => (
        <SortableTable key={`${t.title}-${i}`} table={t} />
      ))}
    </Box>
  );
}
