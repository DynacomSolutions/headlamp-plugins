import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import React from 'react';

/**
 * Asks the operator to approve a launch request. An agent starts only after "Approve and
 * launch". The operator who made the request may approve it.
 */
export function ApprovalCard({
  purpose,
  requestedBy,
  busy,
  error,
  onApprove,
  onReject,
}: {
  purpose: string;
  requestedBy?: string;
  busy: boolean;
  error?: string | null;
  onApprove: () => void;
  onReject: () => void;
}) {
  return (
    <Box
      component="section"
      aria-label="Approval"
      sx={theme => ({
        border: `1px solid ${theme.palette.warning.main}`,
        borderRadius: 2,
        p: 2,
        display: 'flex',
        flexDirection: 'column',
        gap: 1.5,
      })}
    >
      <Typography variant="subtitle1" component="h3" sx={{ fontWeight: 600 }}>
        This agent needs your approval
      </Typography>
      <Typography variant="body2">
        {requestedBy ? `${requestedBy} asked to run an agent` : 'An agent was requested'}: {purpose}
      </Typography>
      <Typography variant="body2" color="text.secondary">
        The agent starts only after you approve. It runs with its own tools and full access in its
        project. You may approve your own request.
      </Typography>
      {error && <Alert severity="error">{error}</Alert>}
      <Box sx={{ display: 'flex', gap: 1 }}>
        <Button variant="contained" disabled={busy} onClick={onApprove}>
          Approve and launch
        </Button>
        <Button variant="outlined" color="inherit" disabled={busy} onClick={onReject}>
          Reject
        </Button>
      </Box>
    </Box>
  );
}
