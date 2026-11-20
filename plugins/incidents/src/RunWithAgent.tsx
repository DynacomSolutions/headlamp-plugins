import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import ButtonBase from '@mui/material/ButtonBase';
import Collapse from '@mui/material/Collapse';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import MenuItem from '@mui/material/MenuItem';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import React from 'react';
import { useHistory } from 'react-router-dom';
import { cleanErrorText } from './chat-model';
import { LaunchRequestBody, previewBrief, requestLaunch } from './launch-data';
import { LaunchConfig, LaunchFix } from './launch-model';
import { Settings } from './model';
import { launchUrl } from './routes';

export interface RunTarget {
  diagnosisId: string;
  alertName: string;
  fix: LaunchFix;
}

/** The text in the purpose box when the dialog opens. */
export const defaultPurpose = (t: RunTarget): string =>
  `${t.fix.title} (${t.alertName || 'incident'})`.slice(0, 200);

/**
 * Asks for an agent run: the purpose, the project and a read-only preview of the brief the
 * agent gets. "Request" only stores a request. The approval card on the launch page starts it.
 */
export function RunWithAgentDialog({
  settings,
  config,
  target,
  onClose,
}: {
  settings: Settings;
  config: LaunchConfig;
  target: RunTarget;
  onClose: () => void;
}) {
  const history = useHistory();
  const [purpose, setPurpose] = React.useState(defaultPurpose(target));
  const [projectKey, setProjectKey] = React.useState(
    config.projects.find(p => p.key === 'default')?.key ?? config.projects[0]?.key ?? 'default'
  );
  const [showBrief, setShowBrief] = React.useState(false);
  const [brief, setBrief] = React.useState<{ text: string; error: string | null } | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const body: LaunchRequestBody = {
    purpose: purpose.trim(),
    diagnosisId: target.diagnosisId,
    fix: target.fix.index,
    projectKey,
  };
  const bodyKey = JSON.stringify(body);

  // The preview is a call to the agent service: an external system. It is read only when opened.
  React.useEffect(() => {
    if (!showBrief || !body.purpose) return undefined;
    let alive = true;
    const timer = setTimeout(() => {
      previewBrief(settings, JSON.parse(bodyKey))
        .then(text => alive && setBrief({ text, error: null }))
        .catch(e => alive && setBrief({ text: '', error: cleanErrorText(e) }));
    }, 250);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [showBrief, bodyKey, settings]);

  const request = async () => {
    setBusy(true);
    setError(null);
    try {
      const launch = await requestLaunch(settings, body);
      history.push(launchUrl(launch.id));
    } catch (e) {
      setError(cleanErrorText(e));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={busy ? undefined : onClose}
      fullWidth
      maxWidth="md"
      aria-labelledby="run-agent-title"
    >
      <DialogTitle id="run-agent-title">Run with an agent</DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: 1 }}>
        <Typography variant="body2" color="text.secondary">
          This sends a request. Nothing starts until you approve it on the next page.
        </Typography>
        <TextField
          label="Purpose"
          value={purpose}
          onChange={e => setPurpose(e.target.value)}
          inputProps={{ maxLength: 200 }}
          fullWidth
          required
        />
        <TextField
          select
          label="Project"
          value={projectKey}
          onChange={e => setProjectKey(e.target.value)}
          fullWidth
        >
          {config.projects.map(p => (
            <MenuItem key={p.key} value={p.key}>
              {p.title}
            </MenuItem>
          ))}
        </TextField>
        <Box>
          <ButtonBase
            onClick={() => setShowBrief(o => !o)}
            aria-expanded={showBrief}
            sx={{ borderRadius: 1, py: 0.25 }}
          >
            <Typography variant="body2" sx={{ fontWeight: 600 }}>
              {showBrief ? 'Hide the brief' : 'Show the brief the agent gets'}
            </Typography>
          </ButtonBase>
          <Collapse in={showBrief} unmountOnExit>
            {brief?.error ? (
              <Alert severity="error">Could not build the brief: {brief.error}</Alert>
            ) : (
              <Box
                component="pre"
                aria-label="Brief"
                sx={theme => ({
                  m: 0,
                  mt: 1,
                  p: 1.5,
                  maxHeight: 320,
                  overflow: 'auto',
                  fontFamily: 'monospace',
                  fontSize: '0.85em',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  border: `1px solid ${theme.palette.divider}`,
                  borderRadius: 1,
                  backgroundColor: theme.palette.action.hover,
                })}
              >
                {brief ? brief.text : 'Loading...'}
              </Box>
            )}
          </Collapse>
        </Box>
        {error && <Alert severity="error">{error}</Alert>}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button variant="contained" onClick={request} disabled={busy || !purpose.trim()}>
          Request
        </Button>
      </DialogActions>
    </Dialog>
  );
}
