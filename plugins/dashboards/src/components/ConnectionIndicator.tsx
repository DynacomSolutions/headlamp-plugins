/*
 * A small, calm note in the header when the server cannot be reached: a dot and the time since
 * when. It takes the place of an error screen. The dashboard below stays as it was. It shows
 * nothing while the link is good, and it never pulses or moves.
 */
import Box from '@mui/material/Box';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import React from 'react';
import { clockTime } from '../refreshStore';
import { Connection } from '../resilience/connection';
import { useConnection } from '../resilience/useConnection';

export function ConnectionIndicator({
  connection,
}: {
  connection?: Connection;
}): JSX.Element | null {
  const state = useConnection(connection);
  if (state.online) return null;
  const since = clockTime(state.since).slice(0, 5);
  return (
    <Tooltip title="The server does not answer. The data on screen is the last good data. This page tries again and reloads itself when the server is back.">
      <Box
        data-connection-indicator
        role="status"
        sx={{ display: 'flex', alignItems: 'center', gap: 0.75, whiteSpace: 'nowrap' }}
      >
        <Box
          aria-hidden
          sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: 'warning.main', flex: 'none' }}
        />
        <Typography variant="caption" color="text.secondary">
          Server unreachable since {since}
        </Typography>
      </Box>
    </Tooltip>
  );
}
