import { Icon } from '@iconify/react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import React from 'react';

/** Shown for a widget type nobody registered: the plugin that supplies it is not installed. */
export function PlaceholderWidget({ type }: { type: string }): JSX.Element {
  return (
    <Box
      data-widget-placeholder
      sx={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', color: 'text.secondary', p: 1 }}
    >
      <Icon icon="mdi:puzzle-outline" width={28} height={28} />
      <Typography variant="body2" sx={{ mt: 0.5 }}>
        Unknown widget type
      </Typography>
      <Typography variant="caption" sx={{ wordBreak: 'break-all' }}>
        {type}
      </Typography>
      <Typography variant="caption">The plugin that supplies this widget is not installed. Its settings are kept.</Typography>
    </Box>
  );
}
