import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Link from '@mui/material/Link';
import Typography from '@mui/material/Typography';
import React from 'react';
import { Link as RouterLink, useHistory } from 'react-router-dom';
import { AgentStatusPill } from './AgentStatusPill';
import { cleanErrorText } from './chat-model';
import { useSettings } from './data';
import {
  approveLaunch,
  rejectLaunch,
  useLaunch,
  useLaunchConfig,
  useLaunches,
} from './launch-data';
import { fixCitesPlan, isLiveLaunch, launchElapsed, LaunchSummary } from './launch-model';
import { ApprovalCard } from './LaunchApproval';
import { useNow } from './LaunchPages';
import { DiagnosisFix } from './model';
import { launchUrl } from './routes';
import { RunTarget, RunWithAgentDialog } from './RunWithAgent';

/** A pending request with its approval card. Approving opens the launch page. */
function PendingLaunch({ launch }: { launch: LaunchSummary }) {
  const settings = useSettings();
  const history = useHistory();
  const detail = useLaunch(settings, launch.id);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      history.push(launchUrl(launch.id));
    } catch (e) {
      setError(cleanErrorText(e));
      setBusy(false);
    }
  };
  return (
    <ApprovalCard
      purpose={launch.purpose}
      requestedBy={launch.requestedBy}
      brief={detail.data?.brief}
      busy={busy}
      error={error ?? detail.error}
      onApprove={() => act(() => approveLaunch(settings, launch.id))}
      onReject={() => act(() => rejectLaunch(settings, launch.id))}
    />
  );
}

/**
 * The "Run with an agent" section of a diagnosis page: a button on each fix (a prominent one
 * for a fix that cites the DNS placement plan), and the launches of this diagnosis. It shows
 * nothing when launching is off on the agent service.
 */
export function AgentActions({
  diagnosisId,
  alertName,
  fixes,
  planFactIds,
}: {
  diagnosisId: string;
  alertName: string;
  fixes: DiagnosisFix[];
  planFactIds: string[];
}) {
  const settings = useSettings();
  const config = useLaunchConfig(settings);
  const launches = useLaunches(settings);
  const [target, setTarget] = React.useState<RunTarget | null>(null);
  const mine = (launches.data ?? []).filter(l => l.diagnosisId === diagnosisId);
  const now = useNow(mine.some(l => isLiveLaunch(l.status)));
  if (!config.data?.enabled) return null;
  if (fixes.length === 0 && mine.length === 0) return null;
  return (
    <Box
      component="section"
      aria-label="Agents"
      sx={{ mt: 3, display: 'flex', flexDirection: 'column', gap: 1.5 }}
    >
      <Typography variant="h6" component="h3">
        Run with an agent
      </Typography>
      {launches.error && (
        <Alert severity="error">Could not load the agents: {launches.error}</Alert>
      )}
      {fixes.map((f, index) => {
        const plan = fixCitesPlan(f, planFactIds);
        return (
          <Box key={`${index}-${f.title}`} sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            <Typography variant="body2" sx={{ flex: 1 }}>
              {index + 1}. {f.title}
              {f.recommended ? ' (recommended)' : ''}
            </Typography>
            <Button
              size={plan ? 'medium' : 'small'}
              variant={plan ? 'contained' : 'outlined'}
              onClick={() =>
                setTarget({
                  diagnosisId,
                  alertName,
                  fix: { index, title: f.title, detail: f.detail, command: f.command },
                })
              }
            >
              {plan ? 'Run the DNS plan with an agent' : 'Run with an agent'}
            </Button>
          </Box>
        );
      })}
      {mine.map(l =>
        l.status === 'pending_approval' ? (
          <PendingLaunch key={l.id} launch={l} />
        ) : (
          <Box key={l.id} sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            <AgentStatusPill status={l.status} elapsed={launchElapsed(l, now)} />
            <Link component={RouterLink} to={launchUrl(l.id)}>
              {l.purpose || l.id}
            </Link>
          </Box>
        )
      )}
      {target && config.data && (
        <RunWithAgentDialog
          settings={settings}
          config={config.data}
          target={target}
          onClose={() => setTarget(null)}
        />
      )}
    </Box>
  );
}
