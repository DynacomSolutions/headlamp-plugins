/*
 * The HoardDB summary strip (`hoarddb.summary`): one compact tile for each engine and each store
 * of the HoardDB source. A tile has an icon, a key number, a name and a status mark. An engine tile
 * shows its count and the node of its primary. A store tile shows failback (engines at home),
 * replication (the worst lag), services, backups and storage. A tile that is not fine takes the
 * status tint. Every tile is drawn: the strip scrolls when the widget is too small, and nothing
 * folds into a "+N more" tile.
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
import { sourceOf } from '../panels/PanelPicker';
import { RowIcon } from '../panels/RowIcon';
import type { PanelSource } from '../panels/sources';
import { useSources } from '../panels/sourcesConfig';
import { StatusMark } from '../panels/StatusMark';
import { useTokens } from '../panels/tokens';
import { ENGINE_WORD } from './join';
import { type SummaryTile, summaryTiles, type TabPanels, type TileKind } from './tab';
import { useTabPanels } from './useTabPanels';

export interface HoardSummaryConfig {
  /** The id of the HoardDB panel source. */
  source: string;
}

/** The bundled icon of a store tile. An engine tile has the icon of its engine row instead. */
export const STORE_ICONS: Record<Exclude<TileKind, 'engine'>, string> = {
  failback: 'mdi:home-outline',
  replication: 'mdi:swap-horizontal',
  services: 'mdi:server-network',
  backups: 'mdi:backup-restore',
  storage: 'mdi:harddisk',
};

const TILE_ICON = 28;

function TileIcon(props: { tile: SummaryTile; source: PanelSource | undefined }): JSX.Element {
  const { tile, source } = props;
  const tk = useTokens();
  if (tile.kind === 'engine') return <RowIcon source={source} icon={tile.icon} />;
  return (
    <Box
      data-tile-icon={tile.kind}
      sx={{
        width: TILE_ICON,
        height: TILE_ICON,
        flex: 'none',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: '8px',
        bgcolor: tk.hover,
        boxShadow: `inset 0 0 0 1px ${tk.line}`,
        color: tk.fg2,
      }}
    >
      <Icon icon={STORE_ICONS[tile.kind]} width={18} height={18} />
    </Box>
  );
}

function Tile(props: {
  tile: SummaryTile;
  source: PanelSource | undefined;
  first: boolean;
}): JSX.Element {
  const { tile, source, first } = props;
  const tk = useTokens();
  return (
    <Box
      data-tile={tile.key}
      data-tile-kind={tile.kind}
      data-tile-status={tile.status}
      title={tile.title}
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        minWidth: 0,
        height: '100%',
        px: '8px',
        py: '4px',
        borderRadius: '8px',
        bgcolor: tile.status === 'ok' ? 'transparent' : tk.fill[tile.status],
        '&:hover': { bgcolor: tk.hover },
        // The first store tile starts after a thin line that sets the stores apart from the engines.
        ...(first ? { boxShadow: `-1px 0 0 ${tk.line2}`, ml: '4px' } : {}),
      }}
    >
      <TileIcon tile={tile} source={source} />
      <Box sx={{ minWidth: 0, flex: '1 1 0' }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 }}>
          <Box
            data-tile-value
            sx={{
              fontSize: 17,
              lineHeight: 1.15,
              fontVariantNumeric: 'tabular-nums',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {tile.value}
          </Box>
          <StatusMark status={tile.status} size={11} />
        </Box>
        <Box
          data-tile-label
          sx={{
            fontSize: 12,
            lineHeight: 1.25,
            color: tk.fg2,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {tile.label}
        </Box>
        {tile.note && (
          <Box
            data-tile-note
            sx={{
              fontSize: 11.5,
              lineHeight: 1.25,
              color: tk.mut,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {tile.note}
          </Box>
        )}
      </Box>
    </Box>
  );
}

/** The words of a status for a screen reader, used by the tile list label. */
export const stripLabel = (tiles: ReadonlyArray<SummaryTile>): string => {
  const bad = tiles.filter(t => t.status !== 'ok');
  return bad.length === 0
    ? 'HoardDB summary: everything is fine'
    : `HoardDB summary: ${bad
        .map(t => `${t.label} ${ENGINE_WORD[t.status].toLowerCase()}`)
        .join(', ')}`;
};

export function HoardSummaryView(props: {
  panels: TabPanels;
  source: PanelSource | undefined;
}): JSX.Element {
  const { panels, source } = props;
  const tiles = React.useMemo(() => summaryTiles(panels), [panels]);
  const firstStore = tiles.findIndex(t => t.kind !== 'engine');
  return (
    <ScrollArea label="HoardDB summary">
      <Box
        data-hoard-summary-strip
        role="list"
        aria-label={stripLabel(tiles)}
        sx={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(136px, 1fr))',
          gridAutoRows: 'minmax(54px, auto)',
          gap: '4px',
          alignContent: 'start',
          minWidth: 0,
        }}
      >
        {tiles.map((t, i) => (
          <Box key={t.key} role="listitem" sx={{ minWidth: 0 }}>
            <Tile tile={t} source={source} first={i === firstStore && i > 0} />
          </Box>
        ))}
      </Box>
    </ScrollArea>
  );
}

export function HoardSummaryWidget({
  config,
  refreshSignal,
  reportRefreshed,
}: WidgetProps<HoardSummaryConfig>): JSX.Element {
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
          <HoardSummaryView panels={s.panels} source={s.source} />
        </Box>
      )}
    </Box>
  );
}

function HoardSummarySettings(props: WidgetSettingsProps<HoardSummaryConfig>): JSX.Element {
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

export const hoardSummaryWidget: WidgetDefinition<HoardSummaryConfig> = {
  type: 'hoarddb.summary',
  title: 'HoardDB summary strip',
  description:
    'One compact tile for each engine and each store: count, status, primary node, failback, lag, services, backups and storage.',
  icon: 'mdi:database',
  category: 'Monitoring',
  defaultSize: { w: 12, h: 3 },
  minSize: { w: 3, h: 3 },
  defaultConfig: { source: 'hoarddb' },
  SettingsComponent: HoardSummarySettings,
  selfScroll: false,
  Component: HoardSummaryWidget,
};
