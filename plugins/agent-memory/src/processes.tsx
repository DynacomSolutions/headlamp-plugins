import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import IconButton from '@mui/material/IconButton';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import React from 'react';
import { formatSize, MemUnit, visibleProcesses } from './model';

/** Chevron toggle shared by the pane rows and the process nodes. */
export function Chevron({
  open,
  label,
  onToggle,
}: {
  open: boolean;
  label: string;
  onToggle: () => void;
}) {
  return (
    <IconButton
      size="small"
      aria-label={label}
      aria-expanded={open}
      onClick={onToggle}
      sx={{ width: 24, height: 24, fontSize: 14 }}
    >
      {open ? '▾' : '▸'}
    </IconButton>
  );
}

/** One-line summary of a scope's processes, shown under the pane name. */
export function processSummary(u: MemUnit): string {
  const t = u.processes;
  if (!t) return u.procs > 0 ? `${u.procs} processes` : '';
  const n = t.total;
  return `${n} process${n === 1 ? '' : 'es'}`;
}

/** The process tree of one scope: indented, with collapsible nodes, largest subtree first. */
export function ProcessTree({ unit }: { unit: MemUnit }) {
  const tree = unit.processes;
  const [collapsed, setCollapsed] = React.useState<ReadonlySet<number>>(new Set());
  const rows = React.useMemo(
    () => (tree ? visibleProcesses(tree, collapsed) : []),
    [tree, collapsed]
  );
  const toggle = (pid: number) =>
    setCollapsed(prev => {
      const next = new Set(prev);
      if (!next.delete(pid)) next.add(pid);
      return next;
    });
  if (!tree || tree.roots.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary">
        No process detail is available for this scope.
      </Typography>
    );
  }
  return (
    <Box>
      <Table size="small" aria-label={`Processes of ${unit.displayName}`}>
        <TableHead>
          <TableRow>
            <TableCell>Command</TableCell>
            <TableCell align="right">PID</TableCell>
            <TableCell align="right">RSS</TableCell>
            <TableCell align="right">With children</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {rows.map(({ node, depth, hasChildren, expanded }) => (
            <TableRow key={node.pid} hover>
              <TableCell sx={{ pl: 1 + depth * 2.5 }}>
                <Box display="flex" alignItems="center" gap={0.5}>
                  {hasChildren ? (
                    <Chevron
                      open={expanded}
                      label={`${expanded ? 'Collapse' : 'Expand'} process ${node.pid}`}
                      onToggle={() => toggle(node.pid)}
                    />
                  ) : (
                    <Box sx={{ width: 24, flex: 'none' }} />
                  )}
                  <Tooltip title={node.command}>
                    <Typography
                      component="span"
                      variant="body2"
                      sx={{ fontFamily: 'monospace', wordBreak: 'break-all' }}
                    >
                      {node.command || '(unknown)'}
                    </Typography>
                  </Tooltip>
                  {node.reparented && (
                    <Tooltip title="Its parent exited and init or the user manager adopted it">
                      <Chip
                        size="small"
                        color="warning"
                        variant="outlined"
                        label="Orphaned process"
                        aria-label={`Orphaned process ${node.pid}`}
                      />
                    </Tooltip>
                  )}
                  {hasChildren && !expanded && (
                    <Typography component="span" variant="caption" color="text.secondary">
                      +{node.subtreeProcs - 1}
                    </Typography>
                  )}
                </Box>
              </TableCell>
              <TableCell align="right">{node.pid}</TableCell>
              <TableCell align="right">{formatSize(node.rss)}</TableCell>
              <TableCell align="right">{hasChildren ? formatSize(node.subtreeRss) : ''}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {tree.shown < tree.total && (
        <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 1 }}>
          Showing {tree.shown} of {tree.total} processes.
        </Typography>
      )}
      <Typography variant="caption" color="text.secondary" display="block">
        RSS counts shared pages once per process, so totals can exceed the scope&apos;s memory.
      </Typography>
    </Box>
  );
}
