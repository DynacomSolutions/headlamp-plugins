/*
 * The details of the selected segment (or, with nothing selected, of the zoom root): its icon,
 * name and kind, the CPU and memory it holds with the share of capacity, of its parent and of the
 * zoom root, a thread link, and the buttons Up and Open. Open zooms both charts to the segment.
 * Below it is the list of its children; tapping a row selects that child. Touch sized.
 */
import { Icon } from '@iconify/react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import Typography from '@mui/material/Typography';
import { formatBytes, formatCores, formatPercent } from '../units';
import type { ChildRow, SegmentInfo,Selection } from './detail';
import { useIconUrl } from './useIconUrl';

export const PANEL_HEIGHT = 200;
/** Width of the details column beside the charts in landscape. */
export const DETAILS_WIDTH = 320;

const KIND: Record<string, string> = {
  node: 'Node',
  category: 'Category',
  namespace: 'Namespace',
  pod: 'Pod',
  container: 'Container',
  orchestrator: 'Agent orchestrator',
  control: 'Control group',
  project: 'Project',
  thread: 'Thread',
  process: 'Process',
  system: 'System',
  unused: 'Empty space',
};

export function kindLabel(kind: string): string {
  return KIND[kind] ?? kind;
}

export function SegmentIcon(props: { icon?: Selection['icon']; size?: number }) {
  const { icon, size = 28 } = props;
  const url = useIconUrl(icon?.kind === 'file' ? icon.src : undefined);
  if (icon?.kind === 'file' && url && url !== 'failed') {
    return <img src={url} width={size} height={size} alt="" />;
  }
  const name = icon && icon.kind !== 'file' ? `${icon.kind}:${icon.name}` : 'mdi:folder';
  if (icon?.kind === 'simple-icons') {
    // Brand icons sit on a light badge, as in the chart.
    return (
      <Box
        component="span"
        sx={{
          display: 'inline-flex',
          bgcolor: '#fff',
          color: '#1f2328',
          borderRadius: '50%',
          p: `${Math.round(size * 0.16)}px`,
          border: '1px solid rgba(0,0,0,0.25)',
        }}
      >
        <Icon icon={name} width={size * 0.68} height={size * 0.68} />
      </Box>
    );
  }
  return <Icon icon={name} width={size} height={size} />;
}

function figures(label: string, fmt: (v: number) => string, info: SegmentInfo | null): string {
  if (!info) return `${label}: no data`;
  const parts = [`${fmt(info.value)}`, `${formatPercent(info.ofCapacity, 1)} of capacity`];
  if (info.ofParent !== null) parts.push(`${formatPercent(info.ofParent, 1)} of parent`);
  if (info.ofRoot !== null) parts.push(`${formatPercent(info.ofRoot, 1)} of root`);
  return `${label}: ${parts.join(', ')}`;
}

export function DetailPanel(props: {
  /** The selection, or the zoom root described as a selection. */
  subject: Selection | null;
  selected: boolean;
  /** Landscape: a column of fixed width, details above the list, each with its own scroll. */
  column?: boolean;
  maxHeight?: number;
  /** Kind line when nothing is selected (the zoom root). */
  rootKind?: string;
  rows: ChildRow[];
  canGoUp: boolean;
  onUp: () => void;
  onOpen: () => void;
  onSelect: (key: string) => void;
}): JSX.Element {
  const { subject, selected, column, maxHeight, rootKind, rows, canGoUp, onUp, onOpen, onSelect } =
    props;
  const btn = { minHeight: 48, minWidth: 48, fontSize: 16 } as const;
  return (
    <Box
      data-detail-panel
      sx={
        column
          ? {
              display: 'flex',
              flexDirection: 'column',
              gap: 1,
              flex: 'none',
              width: DETAILS_WIDTH,
              height: maxHeight,
              minHeight: 0,
              overflow: 'hidden',
            }
          : {
              display: 'flex',
              flexWrap: 'wrap',
              gap: 2,
              mt: 1,
              minHeight: PANEL_HEIGHT,
              maxHeight: PANEL_HEIGHT,
              overflow: 'hidden',
            }
      }
    >
      <Box
        sx={{
          flex: column ? '0 1 auto' : '1 1 420px',
          minWidth: 0,
          minHeight: 0,
          maxHeight: column ? '55%' : undefined,
          overflow: 'auto',
          border: 1,
          borderColor: 'divider',
          borderRadius: 1,
          p: 1.5,
        }}
      >
        {subject && (
          <>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
              <SegmentIcon icon={subject.icon} />
              <Typography sx={{ fontSize: 18, fontWeight: 600, overflowWrap: 'anywhere' }}>
                {subject.label}
              </Typography>
              <Typography sx={{ fontSize: 14 }} color="text.secondary">
                {selected ? kindLabel(subject.kind) : rootKind ?? kindLabel(subject.kind)}
              </Typography>
            </Box>
            {subject.id && (
              <Typography
                data-raw-id
                sx={{
                  fontFamily: 'monospace',
                  fontSize: 14,
                  overflowWrap: 'anywhere',
                  userSelect: 'text',
                }}
                color="text.secondary"
              >
                {subject.id}
              </Typography>
            )}
            <Typography sx={{ fontSize: 14, mt: 0.5 }}>
              {figures('CPU', formatCores, subject.cpu)}
            </Typography>
            <Typography sx={{ fontSize: 14 }}>
              {figures('Memory', formatBytes, subject.mem)}
            </Typography>
          </>
        )}
        <Box sx={{ display: 'flex', gap: 1, mt: 1, flexWrap: 'wrap' }}>
          <Button
            variant="outlined"
            onClick={onUp}
            disabled={!canGoUp}
            aria-label="Up one level"
            startIcon={<Icon icon="mdi:arrow-up" width={24} height={24} />}
            sx={btn}
          >
            Up
          </Button>
          <Button
            variant="contained"
            onClick={onOpen}
            disabled={!selected || !subject?.canOpen}
            aria-label="Open the selected segment"
            startIcon={<Icon icon="mdi:magnify-plus" width={24} height={24} />}
            sx={btn}
          >
            Open
          </Button>
          {subject?.href && /^https?:\/\//i.test(subject.href) && (
            <Button
              component="a"
              href={subject.href}
              target="_blank"
              rel="noopener noreferrer"
              variant="outlined"
              sx={btn}
            >
              Open thread
            </Button>
          )}
        </Box>
      </Box>
      <List
        aria-label="Children"
        dense
        sx={{
          flex: column ? '1 1 0' : '1 1 320px',
          minWidth: 0,
          minHeight: 0,
          overflow: 'auto',
          border: 1,
          borderColor: 'divider',
          borderRadius: 1,
          p: 0,
        }}
      >
        {rows.length === 0 && (
          <Typography sx={{ fontSize: 14, p: 1.5 }} color="text.secondary">
            Nothing below this segment.
          </Typography>
        )}
        {rows.map(r => (
          <ListItemButton
            key={r.key}
            onClick={() => onSelect(r.key)}
            sx={{ minHeight: 48, display: 'flex', gap: 2, fontSize: 14 }}
          >
            <SegmentIcon icon={r.icon} size={24} />
            <Typography sx={{ flex: '1 1 0', minWidth: 0, fontSize: 14 }} noWrap>
              {r.label}
            </Typography>
            <Typography sx={{ fontSize: 14 }} color="text.secondary">
              {r.cpu === null ? 'no CPU' : formatCores(r.cpu)} /{' '}
              {r.mem === null ? 'no memory' : formatBytes(r.mem)}
            </Typography>
          </ListItemButton>
        ))}
      </List>
    </Box>
  );
}
