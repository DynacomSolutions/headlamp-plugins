/*
 * A compact strip under the toolbar with the details of the selected segment (or, with nothing
 * selected, of the zoom root): its icon, name, raw id and kind, the CPU and memory it holds with
 * the share of capacity, of its parent and of the zoom root, and a thread link. Under it a
 * horizontal, scrollable row of chips, one per child, sorted by value; tapping a chip selects that
 * child, as tapping its arc does. Touch sized.
 */
import { Icon } from '@iconify/react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import { formatBytes, formatCores, formatPercent } from '../units';
import type { ChildRow, SegmentInfo,Selection } from './detail';
import { useIconUrl } from './useIconUrl';


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
  /** Kind line when nothing is selected (the zoom root). */
  rootKind?: string;
  rows: ChildRow[];
  onSelect: (key: string) => void;
}): JSX.Element {
  const { subject, selected, rootKind, rows, onSelect } = props;
  return (
    <Box
      data-detail-panel
      sx={{
        display: 'flex',
        flexDirection: 'column',
        gap: 0.5,
        mb: 1,
        minWidth: 0,
        flex: 'none',
      }}
    >
      {subject && (
        <Box sx={{ display: 'flex', alignItems: 'center', columnGap: 2, rowGap: 0.5, flexWrap: 'wrap' }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}>
            <SegmentIcon icon={subject.icon} size={24} />
            <Typography sx={{ fontSize: 18, fontWeight: 600, overflowWrap: 'anywhere' }}>
              {subject.label}
            </Typography>
            <Typography sx={{ fontSize: 14 }} color="text.secondary">
              {selected ? kindLabel(subject.kind) : rootKind ?? kindLabel(subject.kind)}
            </Typography>
            {subject.id && (
              <Typography
                data-raw-id
                sx={{ fontFamily: 'monospace', fontSize: 14, overflowWrap: 'anywhere', userSelect: 'text' }}
                color="text.secondary"
              >
                {subject.id}
              </Typography>
            )}
          </Box>
          <Typography sx={{ fontSize: 14 }}>{figures('CPU', formatCores, subject.cpu)}</Typography>
          <Typography sx={{ fontSize: 14 }}>{figures('Memory', formatBytes, subject.mem)}</Typography>
          {subject.href && /^https?:\/\//i.test(subject.href) && (
            <Button
              component="a"
              href={subject.href}
              target="_blank"
              rel="noopener noreferrer"
              variant="outlined"
              sx={{ minHeight: 48, minWidth: 48, fontSize: 16 }}
            >
              Open thread
            </Button>
          )}
        </Box>
      )}
      <Box
        role="list"
        aria-label="Children"
        sx={{ display: 'flex', gap: 1, overflowX: 'auto', overflowY: 'hidden', pb: 0.5, minHeight: 52 }}
      >
        {rows.length === 0 && (
          <Typography sx={{ fontSize: 14, py: 1.5 }} color="text.secondary">
            Nothing below this segment.
          </Typography>
        )}
        {rows.map(r => (
          <Button
            key={r.key}
            role="listitem"
            variant="outlined"
            onClick={() => onSelect(r.key)}
            startIcon={<SegmentIcon icon={r.icon} size={24} />}
            sx={{ minHeight: 48, flex: 'none', textTransform: 'none', fontSize: 14, whiteSpace: 'nowrap' }}
          >
            {r.label}
            <Box component="span" sx={{ ml: 1, color: 'text.secondary' }}>
              {r.cpu === null ? 'no CPU' : formatCores(r.cpu)} /{' '}
              {r.mem === null ? 'no memory' : formatBytes(r.mem)}
            </Box>
          </Button>
        ))}
      </Box>
    </Box>
  );
}
