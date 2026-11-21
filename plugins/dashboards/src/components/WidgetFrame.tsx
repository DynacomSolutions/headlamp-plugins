/*
 * One widget on the grid: a card with a title row, the widget body and, in edit mode, a drag
 * handle and a menu. It is memoised on the widget's own fields (not its position), so moving or
 * resizing one widget does not rerender the others, and a layout change never refetches data.
 */
import { Icon } from '@iconify/react';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import Typography from '@mui/material/Typography';
import React from 'react';
import { lastGoodStore, widgetCache } from '../cache/lastGood';
import { useDashboardContext } from '../context';
import { useWidgetDefinition } from '../hooks';
import { StaleContext, StaleMarker } from '../resilience/stale';
import { FooterContext } from '../widgets/footer';
import { ErrorBoundary } from './ErrorBoundary';
import { PlaceholderWidget } from './PlaceholderWidget';

export interface FrameActions {
  menu(anchor: HTMLElement, sectionId: string, widgetId: string): void;
  settings(sectionId: string, widgetId: string): void;
}

export interface WidgetFrameProps {
  sectionId: string;
  id: string;
  type: string;
  title: string;
  config: Record<string, unknown>;
  selfScroll: boolean | undefined;
  actions: FrameActions;
  /** Draw in the one row header of the title bar: no card, no title, and the widget gets `compact`. */
  inline?: boolean;
}

function WidgetFrameImpl(props: WidgetFrameProps): JSX.Element {
  const { sectionId, id, type, title, config, selfScroll, actions, inline } = props;
  const { filters, refreshSignal, editing, kiosk, reportRefreshed, cacheScope, reportCached } =
    useDashboardContext();
  const def = useWidgetDefinition(type);
  const merged = React.useMemo(
    () => (def ? { ...def.defaultConfig, ...config } : config),
    [def, config]
  );

  // A failed widget tries again when its id or config changes, for example after a settings edit.
  const resetKey = React.useMemo(() => `${id}\u0000${JSON.stringify(config)}`, [id, config]);
  const shownTitle = title || def?.title || type;
  const card = def ? def.card !== false : true;
  const scroll = selfScroll ?? def?.selfScroll ?? false;

  // The last good data of this widget, kept in the browser (see cache/lastGood.ts).
  const cache = React.useMemo(
    () => (cacheScope ? widgetCache(lastGoodStore(), cacheScope, id) : undefined),
    [cacheScope, id]
  );

  // The header shows how old the cached data is until a fresh answer arrives.
  React.useEffect(() => {
    const at = cacheScope ? lastGoodStore().timeOf(cacheScope, id) : undefined;
    if (at) reportCached?.(at);
    // Once, for the data that the first render showed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A widget that keeps old data while its source fails reports since when (see resilience/stale.tsx).
  const [stale, setStale] = React.useState<{ since: number; cached: boolean } | undefined>(
    undefined
  );
  const setStaleSince = React.useCallback(
    (since: number | undefined, cached?: boolean) =>
      setStale(prev =>
        since === undefined
          ? undefined
          : prev?.since === since && prev.cached === !!cached
          ? prev
          : { since, cached: !!cached }
      ),
    []
  );
  const staleSince = stale?.since;
  // The footer line of the box. A widget draws its summary into it (see widgets/footer.tsx).
  const [footerEl, setFooterEl] = React.useState<HTMLElement | null>(null);
  const body = def ? (
    <StaleContext.Provider value={setStaleSince}>
      <ErrorBoundary resetKey={resetKey}>
        <def.Component
          instanceId={id}
          config={merged}
          filters={filters}
          refreshSignal={refreshSignal}
          reportRefreshed={reportRefreshed}
          editing={editing}
          kiosk={kiosk}
          compact={inline ? true : undefined}
          footer={inline || !card ? undefined : footerEl}
          cache={cache}
        />
      </ErrorBoundary>
    </StaleContext.Provider>
  ) : (
    <PlaceholderWidget type={type} />
  );

  const handle = editing && (
    <Box sx={{ display: 'flex', alignItems: 'center', flex: 'none' }}>
      <Box
        className="widget-drag-handle"
        role="img"
        aria-label={`Drag ${shownTitle}`}
        sx={{
          cursor: 'grab',
          display: 'flex',
          alignItems: 'center',
          color: 'text.secondary',
          mr: 0.5,
          touchAction: 'none',
        }}
      >
        <Icon icon="mdi:drag" width={20} height={20} />
      </Box>
    </Box>
  );

  const menu = editing && (
    <Box sx={{ display: 'flex', flex: 'none' }}>
      <IconButton
        size="small"
        aria-label={`Settings for ${shownTitle}`}
        onClick={() => actions.settings(sectionId, id)}
      >
        <Icon icon="mdi:cog-outline" width={18} height={18} />
      </IconButton>
      <IconButton
        size="small"
        aria-label={`More actions for ${shownTitle}`}
        aria-haspopup="menu"
        onClick={e => actions.menu(e.currentTarget, sectionId, id)}
      >
        <Icon icon="mdi:dots-vertical" width={18} height={18} />
      </IconButton>
    </Box>
  );

  if (inline) {
    return (
      <Box
        data-widget={id}
        sx={{ height: '100%', display: 'flex', alignItems: 'center', minWidth: 0 }}
      >
        {body}
      </Box>
    );
  }

  if (!card) {
    return (
      <Box
        data-widget={id}
        sx={{
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          position: 'relative',
          outline: editing ? '1px dashed' : 'none',
          outlineColor: 'divider',
        }}
      >
        {editing && (
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              position: 'absolute',
              top: 0,
              right: 0,
              zIndex: 1,
              bgcolor: 'background.paper',
              borderRadius: 1,
            }}
          >
            {handle}
            {menu}
          </Box>
        )}
        {staleSince !== undefined && (
          <Box sx={{ position: 'absolute', top: 0, right: 0, zIndex: 1 }}>
            <StaleMarker since={staleSince} cached={stale?.cached} />
          </Box>
        )}
        <Box sx={{ flex: 1, minHeight: 0, overflow: scroll ? 'auto' : 'hidden' }}>{body}</Box>
      </Box>
    );
  }

  // The frame: a box whose title sits on the top edge like a legend, and a footer line at the
  // bottom that the widget fills with its summary (see widgets/footer.tsx).
  return (
    <Box data-widget={id} sx={{ height: '100%', boxSizing: 'border-box', pt: '10px', minWidth: 0 }}>
      <Box
        data-widget-box
        sx={theme => ({
          position: 'relative',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0,
          border: `1px solid ${
            theme.palette.mode === 'dark' ? 'rgba(255,255,255,0.22)' : 'rgba(0,0,0,0.24)'
          }`,
          borderRadius: '10px',
        })}
      >
        <Box
          data-widget-legend
          sx={{
            position: 'absolute',
            top: '-12px',
            left: 12,
            right: 12,
            display: 'flex',
            alignItems: 'center',
            gap: 0.5,
            minHeight: 22,
            pointerEvents: 'none',
            zIndex: 1,
          }}
        >
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              minWidth: 0,
              px: 1,
              bgcolor: 'background.default',
              pointerEvents: 'auto',
            }}
          >
            {handle}
            <Typography
              component="h3"
              noWrap
              sx={{ fontSize: 15, lineHeight: '22px', color: 'text.primary', minWidth: 0 }}
            >
              {shownTitle}
            </Typography>
          </Box>
          <Box sx={{ flex: 1 }} />
          {staleSince !== undefined && (
            <Box sx={{ bgcolor: 'background.default', px: 0.5, pointerEvents: 'auto' }}>
              <StaleMarker since={staleSince} cached={stale?.cached} />
            </Box>
          )}
          {menu && <Box sx={{ bgcolor: 'background.default', pointerEvents: 'auto' }}>{menu}</Box>}
        </Box>
        <Box
          sx={{
            flex: '1 1 0',
            minHeight: 0,
            overflow: scroll ? 'auto' : 'hidden',
            px: 1.25,
            pt: 1.75,
            pb: 0.75,
          }}
        >
          <FooterContext.Provider value={footerEl}>{body}</FooterContext.Provider>
        </Box>
        <Box
          ref={setFooterEl}
          data-widget-footer
          sx={theme => ({
            flex: 'none',
            minHeight: 36,
            alignItems: 'center',
            px: 1.5,
            borderTop: `1px solid ${
              theme.palette.mode === 'dark' ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.12)'
            }`,
            display: 'flex',
            // A widget that draws no summary leaves the footer empty: it takes no room.
            '&:empty': { display: 'none' },
          })}
        />
      </Box>
    </Box>
  );
}

export const WidgetFrame = React.memo(WidgetFrameImpl);
