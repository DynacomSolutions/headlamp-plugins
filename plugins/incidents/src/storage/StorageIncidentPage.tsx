import { SectionBox } from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import LinearProgress from '@mui/material/LinearProgress';
import Link from '@mui/material/Link';
import MenuItem from '@mui/material/MenuItem';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import React from 'react';
import { Link as RouterLink, useHistory, useLocation, useParams } from 'react-router-dom';
import { A2uiRenderer } from '../a2ui';
import { cleanErrorText } from '../chat-model';
import { Composer, MessageView } from '../ChatPage';
import { useSettings } from '../data';
import { Settings } from '../model';
import { storageChatUrl, storageDriveUrl, storageUrl } from '../routes';
import { Capacity, CapacityHistory, size, time } from './Capacity';
import { CleanupPlan, Receipts } from './CleanupPlan';
import {
  ChildResults,
  DriveInvestigation,
  driveLabel,
  ItemActions,
  ItemList,
  QuestionCard,
  Questions,
  useLabel,
  useStorageAction,
} from './Investigation';
import {
  chatPath,
  Drive,
  DriveDetail,
  Item,
  loadStorageTranscriptBefore,
  mergeVerification,
  NodeScan,
  postStorage,
  StorageChatMessage,
  StorageIncident,
  useStorageChat,
  useStorageDrive,
  useStorageIncident,
} from './storage-data';
import { StorageAlert } from './StorageAlert';
import { DeliveryEvidence, noticeUrl, StorageNotices } from './StorageNotices';

const panel = { p: { xs: 2, md: 2.5 }, minWidth: 0, overflowWrap: 'anywhere' } as const;
const driveStatus = {
  critical: { order: 0, label: 'Critical', color: 'error' },
  pressure: { order: 1, label: 'Below reserve', color: 'warning' },
  incomplete: { order: 2, label: 'Incomplete scan', color: 'warning' },
  healthy: { order: 3, label: 'Healthy', color: 'success' },
} as const;

const scanStatus = {
  error: { order: 0, label: 'Scan failed', color: 'error' },
  timeout: { order: 1, label: 'Scan timed out', color: 'error' },
  incomplete: { order: 2, label: 'Incomplete scan', color: 'warning' },
  running: { order: 3, label: 'Running', color: 'info' },
  pending: { order: 4, label: 'Pending', color: 'default' },
  complete: { order: 5, label: 'Complete', color: 'success' },
} as const;

function DriveStatus({ drive }: { drive: Drive }) {
  const status = driveStatus[drive.status];
  return (
    <Chip
      size="small"
      color={status.color}
      variant="outlined"
      label={status.label}
      sx={{ color: 'text.primary' }}
    />
  );
}

function ScannerStatus({ scans }: { scans: NodeScan[] }) {
  const ordered = [...scans].sort(
    (a, b) =>
      scanStatus[a.status].order - scanStatus[b.status].order || a.node.localeCompare(b.node)
  );
  return (
    <Paper
      component="section"
      aria-labelledby="storage-scanner-status"
      variant="outlined"
      sx={panel}
    >
      <Typography id="storage-scanner-status" component="h2" variant="h6" mb={1}>
        Scanner status
      </Typography>
      {ordered.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          No scanner status reported yet.
        </Typography>
      ) : (
        <Box
          component="ul"
          sx={{
            display: 'grid',
            gridTemplateColumns: {
              xs: 'minmax(0, 1fr)',
              sm: 'repeat(2, minmax(0, 1fr))',
              lg: 'repeat(3, minmax(0, 1fr))',
            },
            gap: 1,
            listStyle: 'none',
            m: 0,
            p: 0,
          }}
        >
          {ordered.map(({ node, status, completedAt }) => (
            <Box
              component="li"
              key={node}
              sx={{ border: 1, borderColor: 'divider', borderRadius: 1, px: 1.25, py: 0.75 }}
            >
              <Stack
                direction="row"
                alignItems="center"
                justifyContent="space-between"
                gap={1}
                flexWrap="wrap"
              >
                <Typography variant="body2" fontWeight={600}>
                  {node}
                </Typography>
                <Chip
                  size="small"
                  color={scanStatus[status].color}
                  variant="outlined"
                  label={scanStatus[status].label}
                  sx={{ color: 'text.primary' }}
                />
              </Stack>
              {completedAt && (
                <Typography variant="caption" color="text.secondary">
                  Last recorded completion {time(completedAt)}
                </Typography>
              )}
            </Box>
          ))}
        </Box>
      )}
    </Paper>
  );
}

function Overview({
  incident,
  readsCurrent,
}: {
  incident: StorageIncident;
  readsCurrent: boolean;
}) {
  const drives = [...incident.drives].sort(
    (a, b) => driveStatus[a.status].order - driveStatus[b.status].order
  );
  return (
    <Stack spacing={2}>
      <StorageNotices incident={incident} readsCurrent={readsCurrent} />
      {incident.scans && <ScannerStatus scans={incident.scans} />}
      <Typography component="h2" variant="h6">
        Drives
      </Typography>
      {drives.length === 0 && <StorageAlert severity="info">No drive inventory is available yet.</StorageAlert>}
      <Box
        sx={{
          display: 'grid',
          gap: 2,
          gridTemplateColumns: {
            xs: 'minmax(0, 1fr)',
            md: 'repeat(2, minmax(0, 1fr))',
            xl: 'repeat(3, minmax(0, 1fr))',
          },
        }}
      >
        {drives.map(drive => (
          <Paper key={drive.id} variant="outlined" sx={panel}>
            <Stack spacing={1.5}>
              <Stack
                direction="row"
                gap={1}
                alignItems="center"
                justifyContent="space-between"
                flexWrap="wrap"
              >
                <Link component={RouterLink} to={storageDriveUrl(drive.id)} fontWeight={600}>
                  {driveLabel(drive)}
                </Link>
                <DriveStatus drive={drive} />
              </Stack>
              <Capacity value={drive} />
              <Typography variant="caption" color="text.secondary">
                Last scan {time(drive.scannedAt)}
              </Typography>
            </Stack>
          </Paper>
        ))}
      </Box>
    </Stack>
  );
}

function ItemDetail({
  detail,
  itemId,
  settings,
  refresh,
}: {
  detail: DriveDetail;
  itemId: string;
  settings: Settings;
  refresh: () => void;
}) {
  const item = detail.items.find(item => item.id === itemId);
  if (!item) return <StorageAlert severity="info">This item is absent from the latest inventory.</StorageAlert>;

  const decisions = detail.decisions.filter(entry => entry.itemId === itemId);
  const verification = mergeVerification(item);
  return (
    <Stack spacing={2}>
      <Paper variant="outlined" sx={panel}>
        <Stack spacing={1}>
          <Stack direction="row" gap={1} alignItems="center" flexWrap="wrap">
            <Typography component="h2" variant="h6">
              {item.label}
            </Typography>
            <Chip
              size="small"
              label={
                item.eligible && verification !== 'unavailable'
                  ? 'Eligible for dry run'
                  : 'Excluded'
              }
            />
          </Stack>
          <Typography>
            {size(item.bytes)} · {item.category} · {useLabel(item)}
          </Typography>
          <Typography variant="body2">Owner · {item.owner ?? 'Unavailable'}</Typography>
          <Typography variant="body2">Holder · {item.holder ?? 'Unavailable'}</Typography>
          {verification && (
            <Typography variant="body2">
              {verification === 'verified' ? 'Merge verified' : 'Merge verification unavailable'}
            </Typography>
          )}
          {item.reason && item.reason !== 'Merge verification unavailable' && (
            <Typography variant="body2" color="text.secondary">
              {item.reason}
            </Typography>
          )}
          {item.deferUntil && <StorageAlert severity="info">Deferred until {time(item.deferUntil)}</StorageAlert>}
        </Stack>
      </Paper>
      <Paper variant="outlined" sx={panel}>
        <ItemActions item={item} driveId={detail.drive.id} settings={settings} refresh={refresh} />
        {decisions.length > 0 && (
          <Box component="ul" sx={{ mb: 0, pl: 2.5 }}>
            {decisions.map(entry => (
              <Typography key={entry.id} component="li" variant="body2">
                {time(entry.createdAt)} · {entry.decision === 'keep' ? 'Kept' : 'Deferred'}
                {entry.until && ` until ${time(entry.until)}`}
              </Typography>
            ))}
          </Box>
        )}
      </Paper>
      <Paper variant="outlined" sx={panel}>
        <Questions
          questions={detail.questions.filter(q => q.itemId === itemId)}
          settings={settings}
          refresh={refresh}
        />
      </Paper>
      <Paper variant="outlined" sx={panel}>
        <ChildResults detail={detail} itemId={itemId} />
      </Paper>
    </Stack>
  );
}

function ConsumerGroups({ items, driveId }: { items: Item[]; driveId: string }) {
  const sorted = [...items].sort((a, b) => b.bytes - a.bytes);
  const active = sorted.filter(item => item.inUse === true);
  const other = sorted.filter(item => item.inUse !== true);
  return (
    <Stack spacing={2}>
      <Box>
        <Typography component="h2" variant="h6">
          Active consumers
        </Typography>
        {active.length ? (
          <ItemList items={active} driveId={driveId} />
        ) : (
          <Typography variant="body2" color="text.secondary">
            No items report active use.
          </Typography>
        )}
      </Box>
      {other.length > 0 && (
        <Box>
          <Typography component="h2" variant="h6">
            Idle items and unknown use
          </Typography>
          <ItemList items={other} driveId={driveId} />
        </Box>
      )}
    </Stack>
  );
}

function DriveView({
  id,
  itemId,
  action,
  actionId,
  settings,
  incident,
  readsCurrent,
  refreshIncident,
}: {
  id: string;
  itemId?: string;
  action?: 'question' | 'cleanup';
  actionId?: string;
  settings: Settings;
  incident: StorageIncident;
  readsCurrent: boolean;
  refreshIncident: () => void;
}) {
  const { data, error, loading, refresh } = useStorageDrive(settings, id);
  const refreshAll = () => {
    refresh();
    refreshIncident();
  };
  const canApply =
    readsCurrent && !error && incident.applyEnabled === true && data?.drive.applyEnabled === true;
  const notice = incident.notices.find(
    notice =>
      notice.action?.kind === action &&
      notice.action?.driveId === id &&
      notice.action?.id === actionId
  );
  const question =
    action === 'question' && data?.questions.find(question => question.id === actionId);

  return (
    <Stack spacing={2}>
      {error && (
        <StorageAlert severity="error" action={<Button onClick={refresh}>Retry</Button>}>
          {error}
        </StorageAlert>
      )}
      {loading && <LinearProgress aria-label="Loading drive" />}
      {data && (
        <>
          <Paper variant="outlined" sx={panel}>
            <Stack spacing={1}>
              <Stack
                direction="row"
                gap={1}
                justifyContent="space-between"
                alignItems="center"
                flexWrap="wrap"
              >
                {itemId || action ? (
                  <Link component={RouterLink} to={storageDriveUrl(id)} fontWeight={600}>
                    {driveLabel(data.drive)}
                  </Link>
                ) : (
                  <Typography component="h2" variant="h6">
                    {driveLabel(data.drive)}
                  </Typography>
                )}
                <DriveStatus drive={data.drive} />
              </Stack>
              <Capacity value={data.drive} />
              <Typography variant="caption" color="text.secondary">
                Latest scan {time(data.drive.scannedAt)}
              </Typography>
            </Stack>
          </Paper>
          {action ? (
            <Paper variant="outlined" sx={panel}>
              <Stack spacing={2}>
                <Typography component="h2" variant="h6">
                  {action === 'question' ? 'Storage question' : 'Cleanup finding'}
                </Typography>
                {notice && <DeliveryEvidence delivery={notice.delivery} />}
                {action === 'question' &&
                  (question ? (
                    <QuestionCard
                      key={question.id}
                      question={question}
                      settings={settings}
                      refresh={refreshAll}
                    />
                  ) : (
                    <StorageAlert severity="info">This question is unavailable for this drive.</StorageAlert>
                  ))}
                {action === 'cleanup' &&
                  (notice ? (
                    <>
                      <CleanupPlan
                        detail={data}
                        canApply={canApply}
                        settings={settings}
                        refresh={refreshAll}
                      />
                      <Receipts detail={data} />
                    </>
                  ) : (
                    <StorageAlert severity="info">This cleanup finding is no longer open.</StorageAlert>
                  ))}
              </Stack>
            </Paper>
          ) : itemId ? (
            <ItemDetail
              key={itemId}
              detail={data}
              itemId={itemId}
              settings={settings}
              refresh={refreshAll}
            />
          ) : (
            <>
              <Paper variant="outlined" sx={panel}>
                <CapacityHistory snapshots={data.history} />
              </Paper>
              <Box
                sx={{
                  display: 'grid',
                  gap: 2,
                  alignItems: 'start',
                  gridTemplateColumns: {
                    xs: 'minmax(0, 1fr)',
                    lg: 'minmax(0, 3fr) minmax(0, 2fr)',
                  },
                }}
              >
                <Stack spacing={2} minWidth={0}>
                  <Paper variant="outlined" sx={panel}>
                    <DriveInvestigation detail={data} settings={settings} refresh={refreshAll} />
                  </Paper>
                  <Paper variant="outlined" sx={panel}>
                    <ConsumerGroups items={data.items} driveId={id} />
                  </Paper>
                  <Paper variant="outlined" sx={panel}>
                    <ChildResults detail={data} />
                  </Paper>
                </Stack>
                <Stack spacing={2} minWidth={0}>
                  <Paper variant="outlined" sx={panel}>
                    <Questions
                      questions={data.questions}
                      settings={settings}
                      refresh={refreshAll}
                    />
                  </Paper>
                  <Paper variant="outlined" sx={panel}>
                    <CleanupPlan
                      detail={data}
                      canApply={canApply}
                      settings={settings}
                      refresh={refreshAll}
                    />
                  </Paper>
                  <Paper variant="outlined" sx={panel}>
                    <Receipts detail={data} />
                  </Paper>
                </Stack>
              </Box>
            </>
          )}
        </>
      )}
    </Stack>
  );
}

function mergeMessages(earlier: StorageChatMessage[], later: StorageChatMessage[]) {
  const byId = new Map(earlier.map(message => [message.id, message]));
  later.forEach(message => byId.set(message.id, message));
  return [...byId.values()];
}

function StorageTranscript({
  chatId,
  settings,
  tail,
  hasEarlier,
  notices,
}: {
  chatId: string;
  settings: Settings;
  tail: StorageChatMessage[];
  hasEarlier: boolean;
  notices: StorageIncident['notices'];
}) {
  const [history, setHistory] = React.useState<{
    messages: StorageChatMessage[];
    hasMore: boolean;
  }>();
  const [previousTail, setPreviousTail] = React.useState(tail);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string>();
  if (previousTail !== tail) {
    setPreviousTail(tail);
    if (history && previousTail[0]?.id !== tail[0]?.id) {
      setHistory({ ...history, messages: mergeMessages(history.messages, previousTail) });
    }
  }

  const messages = history ? mergeMessages(history.messages, tail) : tail;
  const before = messages[0]?.id;
  const canLoadEarlier = !!before && (history?.hasMore ?? hasEarlier);
  const loadEarlier = async () => {
    if (!canLoadEarlier || busy) return;
    setBusy(true);
    setError(undefined);
    setHistory(current => current ?? { messages, hasMore: true });
    try {
      const page = await loadStorageTranscriptBefore(settings, chatId, before);
      setHistory(current => ({
        ...page,
        messages: mergeMessages(page.messages, current?.messages ?? messages),
      }));
    } catch (error) {
      setError(cleanErrorText(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {(canLoadEarlier || history) && (
        <Box>
          <Button aria-disabled={busy || !canLoadEarlier} onClick={loadEarlier}>
            Load earlier messages
          </Button>
          <Typography component="span" variant="body2" color="text.secondary" role="status">
            {busy
              ? 'Loading earlier messages…'
              : history && !canLoadEarlier
              ? 'Start of transcript'
              : ''}
          </Typography>
        </Box>
      )}
      {error && <StorageAlert severity="error">{error}</StorageAlert>}
      {messages.length === 0 && (
        <Typography color="text.secondary">
          Ask about capacity, active consumers or cleanup eligibility.
        </Typography>
      )}
      {messages.map(message => (
        <Stack key={message.id} spacing={1}>
          <MessageView m={message} />
          {message.a2ui && <A2uiRenderer messages={message.a2ui} />}
          {notices
            .filter(notice => notice.questionId && message.questionIds.includes(notice.questionId))
            .map(
              notice =>
                notice.action && (
                  <Link key={notice.id} component={RouterLink} to={noticeUrl(notice.action)}>
                    Open question from this message
                  </Link>
                )
            )}
        </Stack>
      ))}
    </>
  );
}

function StorageChat({
  chatId,
  settings,
  incident,
  refreshIncident,
  readsCurrent,
}: {
  chatId: string;
  settings: Settings;
  incident: StorageIncident;
  refreshIncident: () => void;
  readsCurrent: boolean;
}) {
  const location = useLocation();
  const history = useHistory();
  const requestedDrive = new URLSearchParams(location.search).get('drive');
  const drive = incident.drives.find(drive => drive.id === requestedDrive);
  const chat = useStorageChat(settings, chatId);
  const detail = useStorageDrive(settings, drive?.id);
  const { busy, error, run } = useStorageAction(() => {
    chat.refresh();
    detail.refresh();
    refreshIncident();
  });
  const send = (text: string) =>
    run(() =>
      postStorage(settings, `${chatPath(chatId)}/messages`, {
        text,
        ...(drive ? { driveId: drive.id } : {}),
      })
    );
  return (
    <Stack spacing={2}>
      <StorageNotices incident={incident} readsCurrent={readsCurrent} />
      <Paper variant="outlined" sx={panel}>
        <Stack spacing={2}>
          <Stack direction="row" gap={2} alignItems="center" flexWrap="wrap">
            <Typography component="h2" variant="h6">
              Storage incident chat
            </Typography>
            <TextField
              select
              label="Drive context"
              size="small"
              value={drive?.id ?? 'all'}
              onChange={event =>
                history.replace(
                  storageChatUrl(
                    chatId,
                    event.target.value === 'all' ? undefined : event.target.value
                  )
                )
              }
              sx={{ minWidth: 180 }}
            >
              <MenuItem value="all">All drives</MenuItem>
              {incident.drives.map(drive => (
                <MenuItem key={drive.id} value={drive.id}>
                  {driveLabel(drive)}
                </MenuItem>
              ))}
            </TextField>
            {drive && (
              <Link component={RouterLink} to={storageDriveUrl(drive.id)}>
                Open drive
              </Link>
            )}
          </Stack>
          {chat.loading && <LinearProgress aria-label="Loading storage chat" />}
          {chat.error && (
            <StorageAlert severity="error" action={<Button onClick={chat.refresh}>Retry</Button>}>
              {chat.error}
            </StorageAlert>
          )}
          {chat.data && (
            <StorageTranscript
              chatId={chatId}
              settings={settings}
              tail={chat.data.messages}
              hasEarlier={chat.data.hasEarlier}
              notices={incident.notices}
            />
          )}
          {busy && (
            <Typography variant="body2" role="status">
              Investigating…
            </Typography>
          )}
          {error && <StorageAlert severity="error">{error}</StorageAlert>}
          <Composer
            running={busy}
            disabled={!chat.data}
            onSend={send}
            picker={
              <Typography variant="caption" color="text.secondary" sx={{ ml: 1 }}>
                Storage evidence
              </Typography>
            }
            placeholder="Ask what is using space or what changed"
          />
        </Stack>
      </Paper>
      {detail.error && <StorageAlert severity="error">{detail.error}</StorageAlert>}
      {detail.data && (
        <Paper variant="outlined" sx={panel}>
          <ChildResults detail={detail.data} />
        </Paper>
      )}
    </Stack>
  );
}

export function StorageQuestionPage() {
  return <StoragePage action="question" />;
}

export function StorageFindingPage() {
  return <StoragePage action="cleanup" />;
}

export function StorageIncidentPage() {
  return <StoragePage />;
}

function StoragePage({ action }: { action?: 'question' | 'cleanup' }) {
  const { driveId, itemId, chatId, actionId } = useParams<{
    driveId?: string;
    itemId?: string;
    chatId?: string;
    actionId?: string;
  }>();
  const settings = useSettings();
  const incident = useStorageIncident(settings);
  const parent = incident.data?.incident;
  const linkedNotice = incident.data?.notices.find(
    notice =>
      notice.action?.kind === action &&
      notice.action.driveId === driveId &&
      notice.action.id === actionId
  );
  const chatTarget = linkedNotice?.action.chatId ?? parent?.chatId;
  const isOverview = !driveId && !chatId;

  return (
    <SectionBox
      title={
        <Stack direction="row" alignItems="center" gap={1.5} flexWrap="wrap">
          {isOverview ? (
            <Typography component="h1" variant="h5">
              Storage incident
            </Typography>
          ) : (
            <Link component={RouterLink} to={storageUrl()} variant="h5">
              Storage incident
            </Link>
          )}
          {chatTarget && !chatId && (
            <Button
              component={RouterLink}
              to={storageChatUrl(chatTarget, driveId)}
              variant="outlined"
              size="small"
            >
              Open incident chat
            </Button>
          )}
        </Stack>
      }
    >
      <Stack spacing={2}>
        {incident.loading && <LinearProgress aria-label="Loading storage incident" />}
        {incident.error && (
          <StorageAlert severity="error" action={<Button onClick={incident.refresh}>Retry</Button>}>
            {incident.error}
          </StorageAlert>
        )}
        {incident.data && !incident.data.enabled && (
          <StorageAlert severity="info">Storage incidents are disabled.</StorageAlert>
        )}
        {incident.data?.enabled && (
          <>
            {isOverview && <Overview incident={incident.data} readsCurrent={!incident.error} />}
            {driveId && (
              <DriveView
                key={driveId}
                id={driveId}
                itemId={itemId}
                action={action}
                actionId={actionId}
                settings={settings}
                incident={incident.data}
                readsCurrent={!incident.error}
                refreshIncident={incident.refresh}
              />
            )}
            {chatId && chatId === parent?.chatId && (
              <StorageChat
                key={chatId}
                chatId={chatId}
                settings={settings}
                incident={incident.data}
                refreshIncident={incident.refresh}
                readsCurrent={!incident.error}
              />
            )}
            {chatId && chatId !== parent?.chatId && (
              <StorageAlert severity="error">Storage chat is unavailable.</StorageAlert>
            )}
          </>
        )}
      </Stack>
    </SectionBox>
  );
}
