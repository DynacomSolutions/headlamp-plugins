import { Icon } from '@iconify/react';
import { SectionBox } from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import ButtonBase from '@mui/material/ButtonBase';
import CircularProgress from '@mui/material/CircularProgress';
import Collapse from '@mui/material/Collapse';
import Link from '@mui/material/Link';
import MenuItem from '@mui/material/MenuItem';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import React from 'react';
import { Link as RouterLink, useHistory, useLocation, useParams } from 'react-router-dom';
import { safeUrl } from './a2ui/Renderer';
import { AgentStatusPill } from './AgentStatusPill';
import { AgentTimeline } from './AgentTimeline';
import { ChatMarkdown } from './chat-markdown';
import { cleanErrorText } from './chat-model';
import { useSettings } from './data';
import {
  approveLaunch,
  rejectLaunch,
  sendLaunchMessage,
  useLaunch,
  useLaunches,
} from './launch-data';
import {
  isLiveLaunch,
  LAUNCH_STATUSES,
  launchElapsed,
  LaunchStatus,
  searchWithStatus,
  statusFilter,
  statusMeta,
} from './launch-model';
import { ApprovalCard } from './LaunchApproval';
import { diagnosesUrl, diagnosisUrl, launchesUrl, launchUrl } from './routes';

/** The current time in ms. It ticks every second while `active`, so live timers count up. */
export function useNow(active: boolean): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!active) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

/* ---------- List ---------- */

export function LaunchesPage() {
  const settings = useSettings();
  const history = useHistory();
  const location = useLocation();
  const { data, loading, error } = useLaunches(settings);
  const filter = statusFilter(location.search);
  const anyLive = !!data?.some(l => isLiveLaunch(l.status));
  const now = useNow(anyLive);
  const rows = (data ?? []).filter(l => !filter || l.status === filter);
  // A filter is a view option: it goes in the query string and replaces the history entry.
  const setFilter = (value: LaunchStatus | null) =>
    history.replace({
      pathname: location.pathname,
      search: searchWithStatus(location.search, value),
    });
  return (
    <SectionBox
      title={
        <Box display="flex" alignItems="center" gap={2}>
          <Link component={RouterLink} to={diagnosesUrl()}>
            Back to incidents
          </Link>
          <Typography variant="h5" component="span">
            Agents
          </Typography>
        </Box>
      }
    >
      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          Could not load the agents: {error}
        </Alert>
      )}
      <Box sx={{ mb: 2, maxWidth: 260 }}>
        <TextField
          select
          size="small"
          fullWidth
          label="Status"
          value={filter ?? ''}
          onChange={e => setFilter((e.target.value || null) as LaunchStatus | null)}
        >
          <MenuItem value="">All</MenuItem>
          {LAUNCH_STATUSES.map(s => (
            <MenuItem key={s} value={s}>
              {statusMeta(s).label}
            </MenuItem>
          ))}
        </TextField>
      </Box>
      {loading && !data ? (
        <CircularProgress aria-label="Loading" />
      ) : rows.length === 0 ? (
        <Typography>{filter ? 'No agents with this status.' : 'No agents yet.'}</Typography>
      ) : (
        <Table size="small">
          <TableHead>
            <TableRow>
              {['Requested', 'Purpose', 'Status', 'Requested by', 'Steps'].map(h => (
                <TableCell key={h}>{h}</TableCell>
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map(l => (
              <TableRow
                key={l.id}
                hover
                sx={{ cursor: 'pointer' }}
                onClick={() => history.push(launchUrl(l.id))}
              >
                <TableCell>{formatTime(l.requestedAt)}</TableCell>
                <TableCell sx={{ maxWidth: 420 }}>
                  <Link
                    component={RouterLink}
                    to={launchUrl(l.id)}
                    onClick={(e: React.MouseEvent) => e.stopPropagation()}
                  >
                    {l.purpose || l.id}
                  </Link>
                </TableCell>
                <TableCell>
                  <AgentStatusPill status={l.status} elapsed={launchElapsed(l, now)} />
                </TableCell>
                <TableCell>{l.requestedBy}</TableCell>
                <TableCell>{l.steps}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </SectionBox>
  );
}

/* ---------- Detail ---------- */

export function LaunchPage() {
  const { id } = useParams<{ id: string }>();
  return <LaunchDetailView key={id} id={id} />;
}

function Collapsible({ title, children }: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false);
  return (
    <Box>
      <ButtonBase
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        sx={{ gap: 0.5, borderRadius: 1, py: 0.25 }}
      >
        <Icon icon={open ? 'mdi:chevron-down' : 'mdi:chevron-right'} width={18} height={18} />
        <Typography variant="body2" sx={{ fontWeight: 600 }}>
          {title}
        </Typography>
      </ButtonBase>
      <Collapse in={open} unmountOnExit>
        {children}
      </Collapse>
    </Box>
  );
}

export function LaunchDetailView({ id }: { id: string }) {
  const settings = useSettings();
  const launch = useLaunch(settings, id);
  const l = launch.data;
  const live = !!l && isLiveLaunch(l.status);
  const now = useNow(live);
  const [busy, setBusy] = React.useState(false);
  const [actionError, setActionError] = React.useState<string | null>(null);
  const [text, setText] = React.useState('');

  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setActionError(null);
    try {
      await work();
      launch.refresh();
    } catch (e) {
      setActionError(cleanErrorText(e));
    } finally {
      setBusy(false);
    }
  };

  const running = l?.timeline.filter(e => e.status === 'running' && e.kind !== 'run').at(-1);
  const threadLink = l?.threadLink ? safeUrl(l.threadLink) : null;
  const canMessage =
    !!l?.threadId && ['running', 'waiting', 'completed', 'failed'].includes(l.status);

  return (
    <SectionBox
      title={
        <Box display="flex" alignItems="center" gap={2} flexWrap="wrap">
          <Link component={RouterLink} to={launchesUrl()}>
            Back to agents
          </Link>
          <Typography variant="h5" component="span">
            {l?.purpose || 'Agent'}
          </Typography>
        </Box>
      }
    >
      {launch.error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          Could not load the agent: {launch.error}
        </Alert>
      )}
      {launch.loading && !l ? (
        <CircularProgress aria-label="Loading" />
      ) : l ? (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.5 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
            <AgentStatusPill
              status={l.status}
              elapsed={launchElapsed(l, now)}
              activity={live ? running?.title : undefined}
            />
            <Typography variant="body2" color="text.secondary">
              Requested by {l.requestedBy || 'an operator'} on {formatTime(l.requestedAt)}
              {l.decidedBy ? `, decided by ${l.decidedBy}` : ''}
            </Typography>
            {l.diagnosisId && (
              <Link component={RouterLink} to={diagnosisUrl(l.diagnosisId)}>
                Open the incident
              </Link>
            )}
            {threadLink && (
              <Link href={threadLink} target="_blank" rel="noopener noreferrer">
                Open the thread in T3 Code
              </Link>
            )}
          </Box>

          {l.status === 'pending_approval' && (
            <ApprovalCard
              purpose={l.purpose}
              requestedBy={l.requestedBy}
              busy={busy}
              error={actionError}
              onApprove={() => act(() => approveLaunch(settings, id))}
              onReject={() => act(() => rejectLaunch(settings, id))}
            />
          )}
          {l.status !== 'pending_approval' && actionError && (
            <Alert severity="error">{actionError}</Alert>
          )}
          {l.status === 'failed' && (
            <Alert severity="error">{l.error || 'The agent failed.'}</Alert>
          )}
          {l.status === 'rejected' && (
            <Alert severity="info">This request was rejected. No agent was started.</Alert>
          )}

          {l.status !== 'pending_approval' && l.status !== 'rejected' && (
            <AgentTimeline timeline={l.timeline} now={now} />
          )}

          {l.lastReply && (
            <Box component="section" aria-label="Latest reply">
              <Typography variant="subtitle1" component="h3" sx={{ fontWeight: 600, mb: 1 }}>
                Latest reply
              </Typography>
              <ChatMarkdown source={l.lastReply} />
            </Box>
          )}

          {canMessage && (
            <Box sx={{ display: 'flex', gap: 1, alignItems: 'flex-start' }}>
              <TextField
                label="Follow-up message"
                value={text}
                onChange={e => setText(e.target.value)}
                multiline
                minRows={2}
                maxRows={8}
                fullWidth
                inputProps={{ maxLength: 8000 }}
              />
              <Button
                variant="contained"
                disabled={busy || !text.trim()}
                onClick={() =>
                  act(async () => {
                    await sendLaunchMessage(settings, id, text.trim());
                    setText('');
                  })
                }
              >
                Send
              </Button>
            </Box>
          )}

          {l.brief && (
            <Collapsible title="Brief the agent got">
              <Box
                component="pre"
                sx={theme => ({
                  m: 0,
                  mt: 1,
                  p: 1.5,
                  maxHeight: 360,
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
                {l.brief}
              </Box>
            </Collapsible>
          )}
        </Box>
      ) : null}
    </SectionBox>
  );
}
