import { SectionBox } from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Link from '@mui/material/Link';
import Typography from '@mui/material/Typography';
import React from 'react';
import { Link as RouterLink, useHistory, useParams } from 'react-router-dom';
import { A2uiRenderer } from './a2ui';
import { AgentActions } from './AgentActions';
import { createChat } from './chat-data';
import { ChatPage } from './ChatPage';
import { rerunDiagnosis, useDiagnoses, useDiagnosis, useSettings } from './data';
import { IncidentChats } from './IncidentChats';
import { IncidentsBrowser } from './IncidentsBrowser';
import { LaunchesPage } from './LaunchPages';
import { DiagnosisSummary } from './model';
import { NotificationsPage } from './NotificationsPage';
import { RerunButton } from './RerunButton';
import { chatUrl, diagnosesUrl } from './routes';

export function IncidentsPage() {
  const settings = useSettings();
  const { data, loading, error, refresh } = useDiagnoses(settings);
  const rerun = React.useCallback(
    async (d: DiagnosisSummary) => {
      await rerunDiagnosis(settings, d.id);
      await refresh();
    },
    [settings, refresh]
  );
  return (
    <SectionBox title="Incidents">
      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          Could not load diagnoses: {error}
        </Alert>
      )}
      {loading && !data ? (
        <CircularProgress aria-label="Loading" />
      ) : data && data.length === 0 ? (
        <Typography>No diagnoses yet.</Typography>
      ) : (
        <IncidentsBrowser rows={data ?? []} onRerun={rerun} />
      )}
    </SectionBox>
  );
}

export function IncidentPage() {
  const { id } = useParams<{ id: string }>();
  // Safety net: if a router matches this page first, 'chat' is the chat page.
  if (id === 'chat') return <ChatPage />;
  if (id === 'launches') return <LaunchesPage />;
  if (id === 'notifications') return <NotificationsPage />;
  return <IncidentDetail id={id} />;
}

function IncidentDetail({ id }: { id: string }) {
  const settings = useSettings();
  const history = useHistory();
  const { data, loading, error, refresh } = useDiagnosis(settings, id);
  const [askError, setAskError] = React.useState<string | null>(null);
  const ask = async () => {
    setAskError(null);
    try {
      const chatId = await createChat(settings, { diagnosisId: id });
      history.push(chatUrl(chatId));
    } catch (e: any) {
      setAskError(String(e?.message || e));
    }
  };
  return (
    <SectionBox
      title={
        <Box display="flex" alignItems="center" gap={2}>
          <Link component={RouterLink} to={diagnosesUrl()}>
            Back to incidents
          </Link>
          <Typography variant="h5" component="span">
            Incident
          </Typography>
          <Button size="small" variant="outlined" onClick={ask}>
            Ask about this incident
          </Button>
          {data?.status === 'failed' && (
            <RerunButton
              key={data.status}
              onRerun={async () => {
                await rerunDiagnosis(settings, id);
                await refresh();
              }}
            />
          )}
        </Box>
      }
    >
      {askError && (
        <Alert severity="error" sx={{ mb: 2 }}>
          Could not start a chat: {askError}
        </Alert>
      )}
      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          Could not load the diagnosis: {error}
        </Alert>
      )}
      {loading && !data ? (
        <CircularProgress aria-label="Loading" />
      ) : data ? (
        <>
          <IncidentChats diagnosisId={id} />
          <A2uiRenderer messages={data.a2ui} />
          <AgentActions
            diagnosisId={id}
            alertName={data.alertName}
            fixes={data.fixes}
            planFactIds={data.planFactIds}
          />
        </>
      ) : null}
    </SectionBox>
  );
}
