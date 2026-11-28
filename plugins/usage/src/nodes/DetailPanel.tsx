/*
 * A compact strip under the toolbar with the details of the selected segment (or, with nothing
 * selected, of the zoom root): its icon, name, raw id and kind, the CPU and memory it holds with
 * its share of the active section (the zoom focus, or capacity at the root), the CPU limit and
 * throttling of a thread, and a thread link. Under it a
 * horizontal, scrollable row of chips, one per child, sorted by value; tapping a chip selects that
 * child, as tapping its arc does. Touch sized.
 */
import { Icon } from '@iconify/react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import React from 'react';
import { formatBytes, formatCores, formatPercent } from '../units';
import type { ChildRow, SegmentInfo, Selection } from './detail';
import { TOUCH_MIN, TouchChoice, TouchSheet } from './TouchSheet';
import { capacityWord } from './tree';
import { useIconUrl } from './useIconUrl';

const KIND: Record<string, string> = {
  node: 'Node',
  category: 'Category',
  namespace: 'Namespace',
  pod: 'Pod',
  runner: 'CI runner label',
  repo: 'Repository',
  workflow: 'Workflow',
  job: 'CI job',
  run: 'CI run',
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

/**
 * The value and its share of the active section. At the root that is capacity. When zoomed it is
 * the focus node (`section`); the zoom root itself then shows its value only.
 */
export function figures(
  label: string,
  fmt: (v: number) => string,
  info: SegmentInfo | null,
  opts: { zoomed: boolean; section: string; selected: boolean },
  /** What the share is of: CPU is of allocatable, memory of capacity. */
  base = capacityWord(label === 'CPU' ? 'cpu' : 'memory')
): string {
  if (!info) return `${label}: no data`;
  const parts = [fmt(info.value)];
  if (!opts.zoomed) parts.push(`${formatPercent(info.ofCapacity, 1)} of ${base}`);
  else if (opts.selected) {
    parts.push(
      info.ofRoot === null
        ? `${formatPercent(info.ofCapacity, 1)} of ${base}`
        : `${formatPercent(info.ofRoot, 1)} of ${opts.section}`
    );
  }
  return `${label}: ${parts.join(', ')}`;
}

function withShare(value: string, share: number | null): string {
  return share === null ? value : `${value} (${formatPercent(share, 1)})`;
}

/** Most chips the kiosk shows; the touch list under "All" holds the rest, so the row never scrolls. */
export const KIOSK_CHIPS = 6;

export function DetailPanel(props: {
  /** Kiosk: no scrolling row. A few compact chips and a button that opens the full list. */
  kiosk?: boolean;
  /** The selection, or the zoom root described as a selection. */
  subject: Selection | null;
  selected: boolean;
  /** Kind line when nothing is selected (the zoom root). */
  rootKind?: string;
  rows: ChildRow[];
  /** The zoom focus is not the root. */
  zoomed?: boolean;
  /** Name of the active section (the zoom focus). */
  section: string;
  onSelect: (key: string) => void;
}): JSX.Element {
  const {
    subject,
    selected,
    rootKind,
    rows,
    zoomed = false,
    section,
    onSelect,
    kiosk = false,
  } = props;
  const [listOpen, setListOpen] = React.useState(false);
  const shown = kiosk ? rows.slice(0, KIOSK_CHIPS) : rows;
  const opts = { zoomed, section, selected };
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
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            columnGap: 2,
            rowGap: 0.5,
            flexWrap: 'wrap',
          }}
        >
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
          </Box>
          <Typography sx={{ fontSize: 14 }}>
            {figures('CPU', formatCores, subject.cpu, opts)}
          </Typography>
          <Typography sx={{ fontSize: 14 }}>
            {figures('Memory', formatBytes, subject.mem, opts)}
          </Typography>
          {subject.note && (
            <Typography data-cpu-note sx={{ fontSize: 14 }} color="text.secondary">
              {subject.note}
            </Typography>
          )}
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
        sx={
          kiosk
            ? { display: 'flex', flexWrap: 'wrap', gap: 1, minHeight: 52 }
            : {
                display: 'flex',
                gap: 1,
                overflowX: 'auto',
                overflowY: 'hidden',
                pb: 0.5,
                minHeight: 52,
              }
        }
      >
        {rows.length === 0 && (
          <Typography sx={{ fontSize: 14, py: 1.5 }} color="text.secondary">
            Nothing below this segment.
          </Typography>
        )}
        {shown.map(r => (
          <Button
            key={r.key}
            role="listitem"
            variant="outlined"
            onClick={() => onSelect(r.key)}
            startIcon={<SegmentIcon icon={r.icon} size={24} />}
            sx={{
              minHeight: 48,
              flex: 'none',
              textTransform: 'none',
              fontSize: kiosk ? 16 : 14,
              whiteSpace: 'nowrap',
            }}
          >
            {r.label}
            {!kiosk && (
              <Box component="span" sx={{ ml: 1, color: 'text.secondary' }}>
                {r.cpu === null ? 'no CPU' : withShare(formatCores(r.cpu), r.cpuShare)} /{' '}
                {r.mem === null ? 'no memory' : withShare(formatBytes(r.mem), r.memShare)}
              </Box>
            )}
          </Button>
        ))}
        {kiosk && rows.length > KIOSK_CHIPS && (
          <Button
            variant="contained"
            onClick={() => setListOpen(true)}
            aria-label={`Show all ${rows.length} children`}
            startIcon={<Icon icon="mdi:format-list-bulleted" width={24} height={24} />}
            sx={{
              minHeight: TOUCH_MIN,
              minWidth: TOUCH_MIN,
              flex: 'none',
              fontSize: 16,
              textTransform: 'none',
            }}
          >
            All {rows.length}
          </Button>
        )}
      </Box>
      {kiosk && (
        <TouchSheet open={listOpen} title="Children" onClose={() => setListOpen(false)}>
          {rows.map(r => (
            <TouchChoice
              key={r.key}
              label={`${r.label}  ${r.cpu === null ? 'no CPU' : formatCores(r.cpu)} / ${
                r.mem === null ? 'no memory' : formatBytes(r.mem)
              }`}
              chosen={false}
              onToggle={() => {
                setListOpen(false);
                onSelect(r.key);
              }}
            />
          ))}
        </TouchSheet>
      )}
    </Box>
  );
}
