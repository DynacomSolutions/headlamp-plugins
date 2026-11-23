/*
 * The HoardDB engine list (`hoarddb.detail`): one row for each engine, the worst first. The row
 * joins four panels of the HoardDB source that told the same story in four cards: engines,
 * clusters, failback and services. A row has the engine icon, its name and headline, and three
 * values: ready instances, failback state and the count. The instances and the facts of the
 * cluster, failback and service fold under the row. Every row starts folded, and the user opens
 * it. The list scrolls inside one scroll area, and the summary line stays fixed in the footer.
 */
import { Icon } from '@iconify/react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import MenuItem from '@mui/material/MenuItem';
import TextField from '@mui/material/TextField';
import React from 'react';
import { ScrollArea } from '../../components/ScrollArea';
import type { WidgetDefinition, WidgetProps, WidgetSettingsProps } from '../../contract';
import { WidgetFooter } from '../footer';
import { sourceOf } from '../panels/PanelPicker';
import { RowIcon } from '../panels/RowIcon';
import type { PanelSource } from '../panels/sources';
import { useSources } from '../panels/sourcesConfig';
import { StatusMark } from '../panels/StatusMark';
import { useTokens } from '../panels/tokens';
import { ENGINE_WORD } from './join';
import { type DetailRow, detailRows, detailSummary, type TabPanels } from './tab';
import { useTabPanels } from './useTabPanels';

export interface HoardDetailConfig {
  /** The id of the HoardDB panel source. */
  source: string;
}

const COLUMNS = '16px 14px 28px minmax(0, 1fr) 76px 64px 72px';

function Fact(props: { children: React.ReactNode; status?: DetailRow['status']; name: string }) {
  const { children, status, name } = props;
  const tk = useTokens();
  return (
    <Box
      data-fact={name}
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        minWidth: 0,
        fontSize: 12.5,
        lineHeight: 1.35,
        color: tk.fg2,
      }}
    >
      {status && <StatusMark status={status} size={10} />}
      <Box sx={{ minWidth: 0, overflowWrap: 'anywhere' }}>{children}</Box>
    </Box>
  );
}

function Body(props: { row: DetailRow }): JSX.Element {
  const { row } = props;
  const tk = useTokens();
  const away = row.failback && row.failback.status !== 'ok';
  return (
    <Box
      data-engine-body
      sx={{
        display: 'flex',
        flexDirection: 'column',
        gap: '3px',
        py: '6px',
        pl: '60px',
        pr: 1.5,
        minWidth: 0,
        boxShadow: `inset 0 -1px 0 ${tk.line}`,
      }}
    >
      {row.nodes.map(n => (
        <Fact key={`${n.instance ?? ''}/${n.name}`} status={n.status} name="instance">
          <Box component="span" sx={{ color: tk.fg }}>
            {n.instance ?? n.name}
          </Box>
          {n.instance !== undefined && n.instance !== n.name ? `, node ${n.name}` : ''}
          {n.role ? `, ${n.role}` : n.primary ? ', primary' : ''}
          {n.note ? `, ${n.note}` : ''}
        </Fact>
      ))}
      {row.clusterDetail && <Fact name="cluster">{row.clusterDetail}</Fact>}
      {row.failback && (
        <Fact name="failback" status={row.failback.status}>
          Failback: {row.failback.value}
          {away && row.failback.detail ? `, ${row.failback.detail}` : ''}
        </Fact>
      )}
      {row.service && (
        <Fact name="service" status={row.service.status}>
          Service {row.service.label}: {row.service.value}
          {row.service.detail ? `, ${row.service.detail}` : ''}
        </Fact>
      )}
    </Box>
  );
}

function EngineRow(props: {
  row: DetailRow;
  source: PanelSource | undefined;
  open: boolean;
  toggle: () => void;
}): JSX.Element {
  const { row, source, open, toggle } = props;
  const tk = useTokens();
  const band = row.status !== 'ok';
  const value = (extra?: object) => ({
    fontSize: 15,
    fontVariantNumeric: 'tabular-nums',
    textAlign: 'right' as const,
    whiteSpace: 'nowrap' as const,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    ...extra,
  });
  return (
    <>
      <Box
        data-engine-row={row.name}
        data-row-status={row.status}
        data-open={open ? '' : undefined}
        role="button"
        tabIndex={0}
        aria-expanded={open}
        aria-label={`${open ? 'Fold' : 'Expand'} ${row.name}`}
        onClick={toggle}
        onKeyDown={e => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggle();
          }
        }}
        title={`${row.name}: ${ENGINE_WORD[row.status]}${row.issue ? `, ${row.issue}` : ''}`}
        sx={{
          display: 'grid',
          gridTemplateColumns: COLUMNS,
          alignItems: 'center',
          columnGap: '8px',
          minHeight: 42,
          px: 1,
          cursor: 'pointer',
          bgcolor: band ? tk.fill[row.status] : 'transparent',
          boxShadow: open ? 'none' : `inset 0 -1px 0 ${tk.line}`,
          '&:hover': { bgcolor: band ? tk.fill[row.status] : tk.hover },
        }}
      >
        <Box
          sx={{
            display: 'inline-flex',
            transform: open ? 'none' : 'rotate(-90deg)',
          }}
        >
          <Icon icon="mdi:chevron-down" width={16} height={16} />
        </Box>
        <StatusMark status={row.status} size={14} />
        <RowIcon source={source} icon={row.icon} />
        <Box sx={{ minWidth: 0 }}>
          <Box
            data-engine-name
            sx={{
              fontSize: 15,
              lineHeight: 1.25,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {row.name}
          </Box>
          <Box
            data-engine-headline
            title={row.headline}
            sx={{
              fontSize: 12,
              lineHeight: 1.25,
              color: tk.fg2,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {row.issue ? `${row.issue}. ` : ''}
            {row.headline}
          </Box>
        </Box>
        <Box data-engine-ready title="Ready instances" sx={value()}>
          {row.ready ?? ''}
        </Box>
        <Box
          data-engine-failback
          title="Failback: is the primary on its home node"
          sx={value({
            color:
              row.failback && row.failback.status !== 'ok'
                ? tk.status[row.failback.status]
                : tk.fg2,
          })}
        >
          {row.failback?.value ?? ''}
        </Box>
        <Box data-engine-count sx={value()}>
          {row.count}
        </Box>
      </Box>
      {open && <Body row={row} />}
    </>
  );
}

export function HoardDetailView(props: {
  panels: TabPanels;
  source: PanelSource | undefined;
}): JSX.Element {
  const { panels, source } = props;
  const rows = React.useMemo(() => detailRows(panels), [panels]);
  const [open, setOpen] = React.useState<ReadonlySet<string>>(new Set());
  const flip = (name: string) =>
    setOpen(prev => {
      const next = new Set(prev);
      if (!next.delete(name)) next.add(name);
      return next;
    });
  const summary = detailSummary(rows);
  return (
    <Box
      data-hoard-detail
      sx={{
        display: 'flex',
        flexDirection: 'column',
        minWidth: 0,
        height: '100%',
        minHeight: 0,
        overflow: 'hidden',
      }}
    >
      <ScrollArea label="Engines">
        <Box data-rows sx={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          {rows.map(r => (
            <EngineRow
              key={r.name}
              row={r}
              source={source}
              open={open.has(r.name)}
              toggle={() => flip(r.name)}
            />
          ))}
        </Box>
      </ScrollArea>
      <WidgetFooter status={summary.status}>
        <span data-detail-summary>{summary.text}</span>
      </WidgetFooter>
    </Box>
  );
}

export function HoardDetailWidget({
  config,
  refreshSignal,
  reportRefreshed,
}: WidgetProps<HoardDetailConfig>): JSX.Element {
  const sourceId = sourceOf(config);
  const s = useTabPanels(sourceId, refreshSignal, reportRefreshed);
  if (s.loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', p: 2 }}>
        <CircularProgress size={24} aria-label="Loading the HoardDB data" />
      </Box>
    );
  }
  return (
    <Box sx={{ height: '100%', minWidth: 0, display: 'flex', flexDirection: 'column' }}>
      {s.error && (
        <Alert severity={s.none ? 'error' : 'warning'} sx={{ mb: 1, flex: 'none' }}>
          {s.none
            ? `Could not load the HoardDB data: ${s.error}`
            : `Refresh failed, showing the last data: ${s.error}`}
        </Alert>
      )}
      {!s.none && (
        <Box sx={{ flex: '1 1 0', minHeight: 0, minWidth: 0 }}>
          <HoardDetailView panels={s.panels} source={s.source} />
        </Box>
      )}
    </Box>
  );
}

function HoardDetailSettings(props: WidgetSettingsProps<HoardDetailConfig>): JSX.Element {
  const { config, onChange } = props;
  const sources = useSources();
  const sourceId = sourceOf(config);
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: 1 }}>
      <TextField
        select
        size="small"
        label="Source"
        value={sourceId}
        helperText="The panel source that serves the HoardDB panels."
        onChange={e => onChange({ source: e.target.value })}
      >
        {!sources.some(s => s.id === sourceId) && (
          <MenuItem value={sourceId}>{sourceId} (not configured)</MenuItem>
        )}
        {sources.map(s => (
          <MenuItem key={s.id} value={s.id}>
            {s.title}
          </MenuItem>
        ))}
      </TextField>
    </Box>
  );
}

export const hoardDetailWidget: WidgetDefinition<HoardDetailConfig> = {
  type: 'hoarddb.detail',
  title: 'HoardDB engine list',
  description:
    'One row for each engine, the worst first, with ready instances, failback and count. Open a row for its instances, cluster facts and service.',
  icon: 'mdi:database',
  category: 'Monitoring',
  defaultSize: { w: 6, h: 10 },
  minSize: { w: 3, h: 4 },
  defaultConfig: { source: 'hoarddb' },
  SettingsComponent: HoardDetailSettings,
  selfScroll: false,
  Component: HoardDetailWidget,
};
