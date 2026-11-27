import { Icon } from '@iconify/react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import { alpha, useTheme } from '@mui/material/styles';
import Switch from '@mui/material/Switch';
import Typography from '@mui/material/Typography';
import React from 'react';
import { cleanErrorText } from './chat-model';
import { saveAutomaticInvestigations, useAutomaticInvestigations, useSettings } from './data';
import { AutomaticInvestigations } from './model';

/** "Changed by alice on 28 Nov 2026, 07:40", or the default when nobody changed it yet. */
export function lastChangeText(state: AutomaticInvestigations): string {
  if (!state.updatedAt) return 'Not changed yet. The default is on.';
  const at = new Date(state.updatedAt);
  const when = Number.isNaN(at.getTime()) ? state.updatedAt : at.toLocaleString();
  return state.updatedBy ? `Last changed by ${state.updatedBy}, ${when}.` : `Last changed ${when}.`;
}

/**
 * The switch "Automatic investigations". It lives on the agent, so it holds for every pod and every person.
 * The page shows what the agent reports and changes only after the agent confirms. An error shows
 * under the switch and the switch keeps the state that the agent holds.
 */
export function AutomaticInvestigationsCard(): JSX.Element {
  const settings = useSettings();
  const theme = useTheme();
  const { data, loading, error, refresh } = useAutomaticInvestigations(settings);
  const [saved, setSaved] = React.useState<AutomaticInvestigations | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [saveError, setSaveError] = React.useState<string | null>(null);
  // The reply to a change is newer than the last poll, so it wins until the next poll.
  const state = saved ?? data;
  React.useEffect(() => {
    if (data) setSaved(null);
  }, [data]);

  const change = async (enabled: boolean) => {
    setBusy(true);
    setSaveError(null);
    try {
      setSaved(await saveAutomaticInvestigations(settings, enabled));
    } catch (e) {
      setSaveError(cleanErrorText(e));
    } finally {
      setBusy(false);
    }
  };

  const on = state?.enabled ?? true;
  const titleId = 'automatic-investigations-title';
  const helpId = 'automatic-investigations-help';
  return (
    <Box
      component="section"
      aria-labelledby={titleId}
      sx={{
        mb: 2,
        p: { xs: 1.5, sm: 2 },
        borderRadius: 2,
        border: `1px solid ${theme.palette.divider}`,
        backgroundColor: state && !on ? alpha(theme.palette.warning.main, 0.08) : 'transparent',
        display: 'flex',
        flexDirection: 'column',
        gap: 1,
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, minWidth: 0 }}>
        <Icon
          icon={on ? 'mdi:robot-outline' : 'mdi:robot-off-outline'}
          width={22}
          height={22}
          aria-hidden
        />
        <Typography
          id={titleId}
          variant="subtitle1"
          component="h2"
          sx={{ fontWeight: 600, flex: 1, minWidth: 0 }}
        >
          Automatic investigations
        </Typography>
        {busy && <CircularProgress size={18} aria-label="Saving" />}
        <Typography variant="body2" color="text.secondary" aria-hidden>
          {state ? (on ? 'On' : 'Off') : ''}
        </Typography>
        {state && (
          <Switch
            checked={on}
            disabled={busy}
            onChange={(_e, checked) => change(checked)}
            inputProps={{ 'aria-label': 'Automatic investigations', 'aria-describedby': helpId }}
          />
        )}
      </Box>
      <Typography id={helpId} variant="body2" color="text.secondary">
        {!state
          ? 'Choose whether the agent investigates new incidents by itself.'
          : on
          ? 'The agent investigates each new incident by itself.'
          : 'The agent does not start an investigation by itself. Incidents still open and notify you. Start an investigation by hand with the Investigate button.'}{' '}
        This setting holds for everyone.
      </Typography>
      {state && (
        <Typography variant="caption" color="text.secondary">
          {lastChangeText(state)}
        </Typography>
      )}
      {loading && !state && <CircularProgress size={18} aria-label="Loading" />}
      {error && state && (
        <Alert severity="warning">Could not read the setting again: {error}</Alert>
      )}
      {error && !state && (
        <Alert
          severity="error"
          action={
            <Button color="inherit" size="small" onClick={() => refresh()}>
              Try again
            </Button>
          }
        >
          Could not load the setting: {error}
        </Alert>
      )}
      {saveError && (
        <Alert severity="error" role="alert" onClose={() => setSaveError(null)}>
          Could not change the setting: {saveError}
        </Alert>
      )}
    </Box>
  );
}
