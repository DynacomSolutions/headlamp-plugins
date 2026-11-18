/*
 * The focused arc in words, and every child of it as a large tappable row. The rows are the way
 * to reach arcs too thin to tap, and the accessible path to every value, so nothing is cut off.
 */
import { Icon } from '@iconify/react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import Typography from '@mui/material/Typography';
import React from 'react';
import { formatBytes, formatCores, formatPercent } from '../units';
import type { Detail, DetailRow } from './detail';
import type { SunNode } from './tree';
import { useIconUrl } from './useIconUrl';

const ICON = 32;

export function NodeIcon({ icon }: { icon: SunNode['icon'] }) {
  const url = useIconUrl(icon?.kind === 'file' ? icon.src : undefined);
  if (!icon) return <Box sx={{ width: ICON, flexShrink: 0 }} />;
  if (icon.kind === 'file' && url && url !== 'failed') {
    return <img src={url} alt="" width={ICON} height={ICON} style={{ flexShrink: 0 }} />;
  }
  const name = icon.kind === 'file' ? 'mdi:folder' : `${icon.kind}:${icon.name}`;
  return (
    <Box sx={{ width: ICON, height: ICON, flexShrink: 0, display: 'flex' }}>
      <Icon icon={name} width={ICON} height={ICON} color={icon.color} />
    </Box>
  );
}

function ThreadLink({ href }: { href: string }) {
  return (
    <Button
      component="a"
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      variant="outlined"
      sx={{ minHeight: 48, minWidth: 88, fontSize: 14 }}
      onClick={(e: React.MouseEvent) => e.stopPropagation()}
    >
      thread
    </Button>
  );
}

/** "1.2 cores · 15% of node", or "no CPU data" when the node is not in the CPU tree. */
function part(
  value: number | null,
  capacity: number,
  format: (v: number) => string,
  what: string
): string {
  return value === null
    ? `no ${what} data`
    : `${format(value)} · ${formatPercent(value, capacity)} of node`;
}

function rowSummary(r: DetailRow, cpuCapacity: number, memCapacity: number): string {
  return `CPU ${part(r.cpu, cpuCapacity, formatCores, 'CPU')}; memory ${part(
    r.mem,
    memCapacity,
    formatBytes,
    'memory'
  )}`;
}

export function DetailPanel(props: {
  detail: Detail;
  cpuCapacity: number;
  memCapacity: number;
  onFocus: (path: string[]) => void;
}) {
  const { detail, cpuCapacity, memCapacity, onFocus } = props;
  const f = detail.focus;
  const stat = (
    label: string,
    value: number | null,
    capacity: number,
    parent: number | null,
    format: (v: number) => string
  ) => (
    <Box component="tr">
      <Box component="th" scope="row" sx={{ textAlign: 'left', pr: 2, fontWeight: 500 }}>
        {label}
      </Box>
      <Box component="td" sx={{ pr: 2 }}>
        {value === null ? '–' : format(value)}
      </Box>
      <Box component="td" sx={{ pr: 2 }}>
        {value === null ? '–' : `${formatPercent(value, capacity)} of node`}
      </Box>
      <Box component="td">
        {value === null || parent === null ? '–' : `${formatPercent(value, parent)} of parent`}
      </Box>
    </Box>
  );

  return (
    <Box sx={{ minWidth: 0 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 1 }}>
        <NodeIcon icon={f.icon} />
        <Typography
          variant="h6"
          component="h2"
          sx={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}
        >
          {f.label}
        </Typography>
        {f.href && <ThreadLink href={f.href} />}
      </Box>
      <Box
        component="table"
        sx={{ fontSize: 14, borderCollapse: 'collapse', mb: 2, '& td, & th': { py: 0.5 } }}
      >
        <tbody>
          {stat('CPU', f.cpu, cpuCapacity, f.cpuParent, formatCores)}
          {stat('Memory', f.mem, memCapacity, f.memParent, formatBytes)}
        </tbody>
      </Box>
      {detail.children.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          Nothing below this level.
        </Typography>
      ) : (
        <List disablePadding aria-label={`Inside ${f.label}`}>
          {detail.children.map(r => (
            <ListItem
              key={r.key}
              disablePadding
              divider
              secondaryAction={r.href ? <ThreadLink href={r.href} /> : undefined}
              sx={{ '& .MuiListItemSecondaryAction-root': { right: 8 } }}
            >
              <ListItemButton
                onClick={() => onFocus(r.path)}
                sx={{ minHeight: 56, gap: 1.5, pr: r.href ? 14 : 2 }}
              >
                <NodeIcon icon={r.icon} />
                <ListItemText
                  primary={r.label}
                  secondary={rowSummary(r, cpuCapacity, memCapacity)}
                  primaryTypographyProps={{ fontSize: 16, sx: { overflowWrap: 'anywhere' } }}
                  secondaryTypographyProps={{ fontSize: 14 }}
                />
              </ListItemButton>
            </ListItem>
          ))}
        </List>
      )}
    </Box>
  );
}
