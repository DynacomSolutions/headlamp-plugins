import { Icon } from '@iconify/react';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import Typography from '@mui/material/Typography';
import React from 'react';
import { LaunchStatus, PillColour, statusMeta } from './launch-model';

/** A MUI palette key for each pill colour. `default` uses the neutral text colour. */
const PALETTE: Record<PillColour, string> = {
  default: 'text.secondary',
  info: 'info.main',
  success: 'success.main',
  error: 'error.main',
  warning: 'warning.main',
};

/**
 * The status of an agent launch: a coloured pill with an icon (a spinner while the agent
 * works), the status name and the elapsed time. It is a live region, so a screen reader
 * hears the change.
 */
export function AgentStatusPill({
  status,
  elapsed,
  activity,
}: {
  status: LaunchStatus;
  elapsed?: string;
  /** What the agent does now, for example the title of the running step. */
  activity?: string;
}) {
  const meta = statusMeta(status);
  const colour = PALETTE[meta.colour];
  return (
    <Box
      role="status"
      aria-live="polite"
      data-status={status}
      sx={theme => ({
        display: 'inline-flex',
        alignItems: 'center',
        gap: 0.75,
        px: 1.25,
        py: 0.5,
        borderRadius: 4,
        border: `1px solid currentColor`,
        color: colour,
        backgroundColor: theme.palette.action.hover,
        maxWidth: '100%',
      })}
    >
      {meta.busy ? (
        <CircularProgress size={14} color="inherit" aria-hidden />
      ) : (
        <Icon icon={meta.icon} width={16} height={16} aria-hidden />
      )}
      <Typography variant="body2" component="span" sx={{ fontWeight: 600 }}>
        {meta.label}
      </Typography>
      {activity && (
        <Typography
          variant="body2"
          component="span"
          noWrap
          sx={{ color: 'text.secondary', maxWidth: 320 }}
        >
          {activity}
        </Typography>
      )}
      {elapsed && (
        <Typography variant="body2" component="time" sx={{ color: 'text.secondary' }}>
          {elapsed}
        </Typography>
      )}
    </Box>
  );
}
