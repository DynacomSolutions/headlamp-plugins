/*
 * One widget on the grid: a card with a title row, the widget body and, in edit mode, a drag
 * handle and a menu. It is memoised on the widget's own fields (not its position), so moving or
 * resizing one widget does not rerender the others, and a layout change never refetches data.
 */
import { Icon } from '@iconify/react';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import React from 'react';
import { useDashboardContext } from '../context';
import { useWidgetDefinition } from '../hooks';
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
}

function WidgetFrameImpl(props: WidgetFrameProps): JSX.Element {
  const { sectionId, id, type, title, config, selfScroll, actions } = props;
  const { filters, refreshSignal, editing, kiosk, reportRefreshed } = useDashboardContext();
  const def = useWidgetDefinition(type);
  const merged = React.useMemo(
    () => (def ? { ...def.defaultConfig, ...config } : config),
    [def, config]
  );

  const shownTitle = title || def?.title || type;
  const card = def ? def.card !== false : true;
  const scroll = selfScroll ?? def?.selfScroll ?? false;

  const body = def ? (
    <ErrorBoundary>
      <def.Component
        instanceId={id}
        config={merged}
        filters={filters}
        refreshSignal={refreshSignal}
        reportRefreshed={reportRefreshed}
        editing={editing}
        kiosk={kiosk}
      />
    </ErrorBoundary>
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
        <Box sx={{ flex: 1, minHeight: 0, overflow: scroll ? 'auto' : 'hidden' }}>{body}</Box>
      </Box>
    );
  }

  return (
    <Paper
      data-widget={id}
      variant="outlined"
      sx={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
    >
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          px: 1,
          py: editing ? 0.25 : 0.5,
          minHeight: 28,
          flex: 'none',
        }}
      >
        {handle}
        <Typography variant="subtitle2" noWrap sx={{ flex: 1, minWidth: 0 }}>
          {shownTitle}
        </Typography>
        {menu}
      </Box>
      <Box sx={{ flex: 1, minHeight: 0, overflow: scroll ? 'auto' : 'hidden', px: 1, pb: 1 }}>
        {body}
      </Box>
    </Paper>
  );
}

export const WidgetFrame = React.memo(WidgetFrameImpl);
