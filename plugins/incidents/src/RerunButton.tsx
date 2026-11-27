import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Typography from '@mui/material/Typography';
import React from 'react';
import { cleanErrorText } from './chat-model';

type Phase = 'idle' | 'busy' | 'sent';

/**
 * Runs a failed diagnosis again. It is disabled while the request runs and after it succeeded
 * (the parent then shows the queued diagnosis, and the button goes away). An error shows
 * under the button and the button works again. A parent that shows the button for a failed
 * row gives it `key={status}`, so a new failure starts with a fresh button.
 */
export function RerunButton({
  onRerun,
  touch,
  alertName,
  compact,
  label = 'Run again',
}: {
  onRerun: () => Promise<void>;
  touch?: boolean;
  alertName?: string;
  /** A narrow place: the error text wraps in a smaller width. */
  compact?: boolean;
  /** The button text. A skipped incident says `Investigate`. */
  label?: string;
}) {
  const [phase, setPhase] = React.useState<Phase>('idle');
  const [error, setError] = React.useState<string | null>(null);
  const click = async (e: React.SyntheticEvent) => {
    // The button sits in a row that opens the incident on click.
    e.stopPropagation();
    setPhase('busy');
    setError(null);
    try {
      await onRerun();
      setPhase('sent');
    } catch (err) {
      setError(cleanErrorText(err));
      setPhase('idle');
    }
  };
  return (
    <Box
      // A click on the disabled button reaches the row too, so the box stops it for all of the cell.
      onClick={e => e.stopPropagation()}
      sx={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 0.5 }}
    >
      <Button
        size={touch ? 'medium' : 'small'}
        variant="outlined"
        disabled={phase !== 'idle'}
        onClick={click}
        aria-label={alertName ? `${label}: ${alertName}` : label}
        startIcon={phase === 'busy' ? <CircularProgress size={14} aria-hidden /> : undefined}
        sx={{ whiteSpace: 'nowrap' }}
      >
        {phase === 'busy' ? 'Starting...' : phase === 'sent' ? 'Queued' : label}
      </Button>
      {error && (
        <Typography
          role="alert"
          variant="caption"
          color="error"
          sx={{ maxWidth: compact ? 140 : 240, overflowWrap: 'anywhere' }}
        >
          {error}
        </Typography>
      )}
    </Box>
  );
}
