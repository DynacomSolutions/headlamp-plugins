import { SectionBox } from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import CircularProgress from '@mui/material/CircularProgress';
import FormControlLabel from '@mui/material/FormControlLabel';
import FormGroup from '@mui/material/FormGroup';
import FormLabel from '@mui/material/FormLabel';
import Switch from '@mui/material/Switch';
import Typography from '@mui/material/Typography';
import React from 'react';
import { useSettings } from './data';
import { usePushDevice } from './push-data';
import { PushSettings, SEVERITY_OPTIONS, SeverityGroup } from './push-model';

/**
 * Push notifications of the incident agent. This is its own subscription, not the one of the Alerting
 * plugin: it has its own key, its own service worker and its own switches. Changes save at once.
 */
export function NotificationsPage() {
  const settings = useSettings();
  const device = usePushDevice(settings);
  const { support, config, view, loading, busy, error } = device;
  const on = Boolean(view);
  const change = (patch: Partial<PushSettings>) => {
    if (view) void device.update({ ...view.settings, ...patch });
  };
  const toggleSeverity = (value: SeverityGroup, checked: boolean) => {
    if (!view) return;
    const next = SEVERITY_OPTIONS.map(o => o.value).filter(v =>
      v === value ? checked : view.settings.severities.includes(v)
    );
    change({ severities: next });
  };
  return (
    <SectionBox title="Incident notifications">
      <Box display="flex" flexDirection="column" gap={2} maxWidth={720}>
        <Typography variant="body2">
          Get a notification on this device when the incident agent has a diagnosis ready, or when
          it has answered a question in the chat. This is separate from the Alerting plugin
          notifications.
        </Typography>
        {support === 'needs-install' && (
          <Alert severity="info">
            On iPhone and iPad, notifications only work from an app added to the Home Screen. Open
            this page in Safari, choose Share, then Add to Home Screen, open the new app and enable
            notifications there.
          </Alert>
        )}
        {support === 'unsupported' && (
          <Alert severity="warning">
            This browser cannot receive web push notifications. Web push needs a secure (https)
            page, a service worker and the Push API.
          </Alert>
        )}
        {error && <Alert severity="error">{error}</Alert>}
        {loading ? (
          <CircularProgress aria-label="Loading" />
        ) : config && !config.enabled ? (
          <Alert severity="warning">
            Push notifications are not set up on the agent, so this device cannot subscribe.
          </Alert>
        ) : (
          <>
            <Box display="flex" alignItems="center" gap={2}>
              <Button
                variant={on ? 'outlined' : 'contained'}
                disabled={busy || support !== 'ok'}
                onClick={() => (on ? device.disable() : device.enable())}
              >
                {on ? 'Disable on this device' : 'Enable on this device'}
              </Button>
              <Typography variant="body2" color="text.secondary">
                {on ? 'Notifications are on for this device.' : 'Notifications are off for this device.'}
              </Typography>
            </Box>
            {view && (
              <>
                <FormGroup>
                  <FormControlLabel
                    control={
                      <Switch
                        checked={view.settings.diagnosis}
                        disabled={busy}
                        onChange={(_e, checked) => change({ diagnosis: checked })}
                      />
                    }
                    label="Diagnosis ready"
                  />
                  <Typography variant="caption" color="text.secondary" sx={{ ml: 6, mt: -0.5 }}>
                    Shows the alert, its severity and the likely cause. A tap opens the incident.
                  </Typography>
                </FormGroup>
                <FormGroup role="group" aria-labelledby="push-severity-label" sx={{ ml: 4 }}>
                  <FormLabel id="push-severity-label" disabled={!view.settings.diagnosis}>
                    Notify for these severities
                  </FormLabel>
                  <Box display="flex" flexWrap="wrap" columnGap={2}>
                    {SEVERITY_OPTIONS.map(o => (
                      <FormControlLabel
                        key={o.value}
                        control={
                          <Checkbox
                            checked={view.settings.severities.includes(o.value)}
                            disabled={busy || !view.settings.diagnosis}
                            onChange={(_e, checked) => toggleSeverity(o.value, checked)}
                          />
                        }
                        label={o.label}
                      />
                    ))}
                  </Box>
                </FormGroup>
                <FormGroup>
                  <FormControlLabel
                    control={
                      <Switch
                        checked={view.settings.chat}
                        disabled={busy}
                        onChange={(_e, checked) => change({ chat: checked })}
                      />
                    }
                    label="Chat answers"
                  />
                  <Typography variant="caption" color="text.secondary" sx={{ ml: 6, mt: -0.5 }}>
                    When you ask a question and then leave the page, you get the start of the
                    answer. Nothing is sent while the chat is visible.
                  </Typography>
                </FormGroup>
                <Typography variant="caption" color="text.secondary">
                  {view.lastSentAt
                    ? `Last notification: ${new Date(view.lastSentAt).toLocaleString()} (${
                        view.lastResult === 'ok' ? 'delivered to the push service' : `result ${view.lastResult}`
                      }).`
                    : 'No notification sent to this device yet.'}
                </Typography>
              </>
            )}
          </>
        )}
      </Box>
    </SectionBox>
  );
}
