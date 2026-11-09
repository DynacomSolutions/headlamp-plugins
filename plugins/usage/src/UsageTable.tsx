/* Sortable table of every group with each enabled resource's value and share. */
import Chip from '@mui/material/Chip';
import Link from '@mui/material/Link';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TableSortLabel from '@mui/material/TableSortLabel';
import Typography from '@mui/material/Typography';
import React from 'react';
import { primaryFor, secondaryFor } from './describe';
import { Group, totalOf } from './model';
import { ResourceDef } from './resources';
import { formatPercent } from './units';

export type SortKey = 'key' | ResourceDef['id'];

export interface SortState {
  key: SortKey;
  dir: 'asc' | 'desc';
}

export function sortGroups(groups: Group[], defs: ResourceDef[], sort: SortState): Group[] {
  const def = defs.find(d => d.id === sort.key);
  const value = (g: Group): number | string => (sort.key === 'key' ? g.key : def ? g.values[def.measure] : 0);
  const sign = sort.dir === 'asc' ? 1 : -1;
  return [...groups].sort((a, b) => {
    const x = value(a);
    const y = value(b);
    const cmp = typeof x === 'string' ? x.localeCompare(y as string) : x - (y as number);
    return sign * cmp || a.key.localeCompare(b.key);
  });
}

export interface UsageTableProps {
  groups: Group[];
  defs: ResourceDef[];
  windowSeconds: number;
  sort: SortState;
  onSort: (key: SortKey) => void;
  onSelect?: (key: string) => void;
  nameOf: (key: string) => string;
}

export function UsageTable({ groups, defs, windowSeconds, sort, onSort, onSelect, nameOf }: UsageTableProps): JSX.Element {
  const totals = Object.fromEntries(defs.map(d => [d.id, totalOf(groups, d.measure)]));
  const header = (key: SortKey, label: string, align: 'left' | 'right') => (
    <TableCell align={align} sortDirection={sort.key === key ? sort.dir : false}>
      <TableSortLabel active={sort.key === key} direction={sort.key === key ? sort.dir : 'desc'} onClick={() => onSort(key)}>
        {label}
      </TableSortLabel>
    </TableCell>
  );

  return (
    <Table size="small" aria-label="Usage by group">
      <TableHead>
        <TableRow>
          {header('key', 'Group', 'left')}
          {defs.map(d => header(d.id, d.label, 'right'))}
        </TableRow>
      </TableHead>
      <TableBody>
        {groups.map(g => (
          <TableRow key={g.key} hover>
            <TableCell sx={{ maxWidth: 360, wordBreak: 'break-all' }}>
              {onSelect ? (
                <Link component="button" variant="body2" underline="hover" onClick={() => onSelect(g.key)} sx={{ textAlign: 'left' }}>
                  {nameOf(g.key)}
                </Link>
              ) : (
                nameOf(g.key)
              )}
              {g.fallback && <Chip size="small" label="workload" variant="outlined" title="Shown under its workload because it could not be placed in this grouping" sx={{ ml: 1, height: 18, fontSize: 11 }} />}
            </TableCell>
            {defs.map(d => (
              <TableCell key={d.id} align="right">
                {primaryFor(d, g.values[d.measure], windowSeconds)} ({formatPercent(g.values[d.measure], totals[d.id])})
                <Typography variant="caption" color="text.secondary" display="block">
                  {secondaryFor(d, g.values, windowSeconds)}
                </Typography>
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
