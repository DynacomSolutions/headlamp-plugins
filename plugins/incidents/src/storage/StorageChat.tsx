/*
 * The storage investigation, as a chat in the one Incidents chat. It has the same frame as every chat. Its thread is the
 * transcript of the storage incident. Under the thread sit the open items of the chosen drive: the unanswered questions
 * and the cleanup plan with its approval card. The Storage tab keeps the drive overview and links here.
 *
 * URL: the chat is a path segment (`/incidents/chat/<chat id>`). The drive context and the item in focus are query
 * strings (`?drive=<id>&question=<id>` or `&finding=<id>`) and change with history replace, so Back leaves the chat.
 */
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
import { Link as RouterLink, useHistory, useLocation } from 'react-router-dom';
import { A2uiRenderer } from '../a2ui';
import { useChats } from '../chat-data';
import { ChatSummary, cleanErrorText } from '../chat-model';
import { Composer, MessageView } from '../ChatParts';
import { ChatShell, useStickToBottom } from '../ChatShell';
import { useSettings } from '../data';
import { Settings } from '../model';
import { chatUrl, storageDriveUrl, storageUrl } from '../routes';
import { size } from './Capacity';
import { CleanupPlan, Receipts } from './CleanupPlan';
import { ChildResults, driveLabel, QuestionCard, useStorageAction } from './Investigation';
import {
  chatPath,
  Drive,
  loadStorageTranscriptBefore,
  Notice,
  postStorage,
  StorageChatMessage,
  StorageIncident,
  useStorageChat,
  useStorageDrive,
} from './storage-data';
import { StorageAlert } from './StorageAlert';
import { DeliveryEvidence } from './StorageNotices';

const panel = { p: { xs: 2, md: 2.5 }, minWidth: 0, overflowWrap: 'anywhere' } as const;

/** The entry of the storage investigation in the chat list. It is not one of the agent's chats. */
export function storageSummary(incident: StorageIncident): ChatSummary | undefined {
  if (!incident.enabled || !incident.incident) return undefined;
  return {
    id: incident.incident.chatId,
    kind: 'storage',
    title: 'Storage investigation',
    model: '',
    updatedAt: incident.incident.createdAt,
    running: false,
  };
}

/** The questions of the quick investigations. The agent reads the kind from the words of the message. */
const QUICK_INVESTIGATIONS = [
  'Investigate consumers',
  'Investigate capacity',
  'Investigate eligibility',
];

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
        <MessageView
          key={message.id}
          m={message}
          extra={
            <>
              {message.a2ui && <A2uiRenderer messages={message.a2ui} />}
              {notices
                .filter(
                  notice => notice.questionId && message.questionIds.includes(notice.questionId)
                )
                .map(
                  notice =>
                    notice.action && (
                      <Link
                        key={notice.id}
                        component={RouterLink}
                        to={chatUrl(chatId, {
                          drive: notice.driveId,
                          question: notice.action.id,
                        })}
                      >
                        Open question from this message
                      </Link>
                    )
                )}
            </>
          }
        />
      ))}
    </>
  );
}

/** The open items of one drive: its questions, its cleanup plan with the approval card, and its investigation results. */
function DriveItems({
  settings,
  incident,
  drive,
  question,
  finding,
  readsCurrent,
  refresh,
}: {
  settings: Settings;
  incident: StorageIncident;
  drive: Drive;
  question?: string;
  finding?: string;
  readsCurrent: boolean;
  refresh: () => void;
}) {
  const detail = useStorageDrive(settings, drive.id);
  const refreshAll = () => {
    detail.refresh();
    refresh();
  };
  const data = detail.data;
  const canApply =
    readsCurrent && !detail.error && incident.applyEnabled === true && data?.drive.applyEnabled === true;
  const focus = React.useRef<HTMLDivElement | null>(null);
  // The question or the finding that a notification named scrolls into view when the drive has loaded.
  const focusKey = `${question ?? ''}|${finding ?? ''}|${data ? 'loaded' : 'loading'}`;
  React.useEffect(() => {
    if (data && (question || finding)) focus.current?.scrollIntoView?.({ block: 'nearest' });
  }, [focusKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const notice = (kind: Notice['kind'], id?: string) =>
    incident.notices.find(n => n.kind === kind && n.driveId === drive.id && n.action.id === id);

  return (
    <Stack spacing={2} data-drive-items={drive.id}>
      {detail.error && (
        <StorageAlert severity="error" action={<Button onClick={detail.refresh}>Retry</Button>}>
          {detail.error}
        </StorageAlert>
      )}
      {detail.loading && <LinearProgress aria-label="Loading drive" />}
      {data && (
        <>
          <Paper variant="outlined" sx={panel}>
            <Stack spacing={1.5}>
              <Typography component="h2" variant="h6">
                Questions · {data.questions.filter(q => !q.answer).length} unanswered
              </Typography>
              {data.questions.length === 0 && (
                <Typography color="text.secondary">No questions yet.</Typography>
              )}
              {[...data.questions]
                .sort((a, b) => Number(!!a.answer) - Number(!!b.answer))
                .map(q => {
                  const focused = q.id === question;
                  const delivery = focused ? notice('question', q.id)?.delivery : undefined;
                  return (
                    <Box
                      key={q.id}
                      ref={focused ? focus : undefined}
                      sx={theme => ({
                        borderRadius: 1.5,
                        ...(focused && {
                          outline: `2px solid ${theme.palette.primary.main}`,
                          outlineOffset: 6,
                        }),
                      })}
                    >
                      <QuestionCard question={q} settings={settings} refresh={refreshAll} />
                      {focused && <DeliveryEvidence delivery={delivery} />}
                    </Box>
                  );
                })}
            </Stack>
          </Paper>
          <Paper
            variant="outlined"
            sx={theme => ({
              ...panel,
              ...(finding && { outline: `2px solid ${theme.palette.primary.main}`, outlineOffset: 4 }),
            })}
            ref={finding ? focus : undefined}
          >
            <Stack spacing={1.5}>
              {finding && <DeliveryEvidence delivery={notice('cleanup', finding)?.delivery} />}
              <CleanupPlan detail={data} canApply={canApply} settings={settings} refresh={refreshAll} />
              <Receipts detail={data} />
            </Stack>
          </Paper>
          <Paper variant="outlined" sx={panel}>
            <ChildResults detail={data} />
          </Paper>
        </>
      )}
    </Stack>
  );
}

/** Without a drive context: the open items of every drive, each opening the chat on its drive. */
function OpenNotices({ chatId, incident }: { chatId: string; incident: StorageIncident }) {
  if (incident.notices.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary">
        No open findings or questions. Choose a drive to investigate it.
      </Typography>
    );
  }
  return (
    <Stack spacing={1}>
      <Typography component="h2" variant="h6">
        Findings and questions
      </Typography>
      {incident.notices.map(notice => {
        const drive = incident.drives.find(d => d.id === notice.driveId);
        if (!drive || !notice.action) return null;
        return (
          <Paper key={notice.id} variant="outlined" sx={{ p: 1.5, overflowWrap: 'anywhere' }}>
            <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" gap={1}>
              <Stack spacing={0.25}>
                <Link
                  component={RouterLink}
                  to={chatUrl(chatId, {
                    drive: notice.driveId,
                    [notice.kind === 'question' ? 'question' : 'finding']: notice.action.id,
                  })}
                  fontWeight={600}
                >
                  {notice.kind === 'question' ? 'Review unanswered question' : 'Review cleanup finding'}
                </Link>
                <Typography variant="body2" color="text.secondary">
                  {driveLabel(drive)}
                  {notice.kind === 'cleanup' &&
                    notice.eligibleCount !== undefined &&
                    ` · ${notice.eligibleCount} eligible`}
                </Typography>
              </Stack>
              <DeliveryEvidence delivery={notice.delivery} />
            </Stack>
          </Paper>
        );
      })}
    </Stack>
  );
}

export function StorageChatView({
  chatId,
  incident,
  refreshIncident,
  readsCurrent,
}: {
  chatId: string;
  incident: StorageIncident;
  refreshIncident: () => void;
  readsCurrent: boolean;
}) {
  const settings = useSettings();
  const location = useLocation();
  const history = useHistory();
  const query = new URLSearchParams(location.search);
  const question = query.get('question') ?? undefined;
  const finding = query.get('finding') ?? undefined;
  // A notification link names the item. The drive of the item is the context when the link names no drive.
  const itemNotice = incident.notices.find(
    n => n.action.id === (question ?? finding) && n.kind === (question ? 'question' : 'cleanup')
  );
  const requestedDrive = query.get('drive') ?? (question || finding ? itemNotice?.driveId : undefined);
  const drive = incident.drives.find(d => d.id === requestedDrive);
  const chats = useChats(settings);
  const list = React.useMemo(
    () => [storageSummary(incident)!, ...(chats.data ?? [])],
    [incident, chats.data]
  );
  const chat = useStorageChat(settings, chatId);
  const { busy, error, run } = useStorageAction(() => {
    chat.refresh();
    refreshIncident();
  });
  const send = (text: string) =>
    run(() =>
      postStorage(settings, `${chatPath(chatId)}/messages`, {
        text,
        ...(drive ? { driveId: drive.id } : {}),
      })
    );
  const messages = chat.data?.messages ?? [];
  // A link that names an item shows that item: the thread does not jump to the bottom then.
  const scroll = useStickToBottom(messages, !(question || finding));
  // The context changes the view, not the history: the query is replaced.
  const setDrive = (id?: string) => history.replace(chatUrl(chatId, id ? { drive: id } : {}));

  return (
    <ChatShell
      chats={list}
      activeId={chatId}
      onDelete={() => undefined}
      wide
      header={
        <Stack direction="row" gap={1.5} alignItems="center" flexWrap="wrap">
          <Typography component="h1" variant="subtitle1" fontWeight={600}>
            Storage investigation
          </Typography>
          <TextField
            select
            label="Drive context"
            size="small"
            value={drive?.id ?? 'all'}
            onChange={event => setDrive(event.target.value === 'all' ? undefined : event.target.value)}
            sx={{ minWidth: { xs: '100%', sm: 180 } }}
          >
            <MenuItem value="all">All drives</MenuItem>
            {incident.drives.map(d => (
              <MenuItem key={d.id} value={d.id}>
                {driveLabel(d)}
              </MenuItem>
            ))}
          </TextField>
          {drive ? (
            <Link component={RouterLink} to={storageDriveUrl(drive.id)}>
              Open drive
            </Link>
          ) : (
            <Link component={RouterLink} to={storageUrl()}>
              Storage overview
            </Link>
          )}
          {drive && (
            <Chip
              size="small"
              variant="outlined"
              label={`${size(drive.availableBytes)} free`}
              sx={{ color: 'text.primary', display: { xs: 'none', sm: 'inline-flex' } }}
            />
          )}
        </Stack>
      }
      scroll={scroll}
      footer={
        <>
          {busy && (
            <Typography variant="body2" role="status">
              Investigating…
            </Typography>
          )}
          {error && <StorageAlert severity="error">{error}</StorageAlert>}
          <Stack direction="row" gap={1} flexWrap="wrap">
            {QUICK_INVESTIGATIONS.map(text => (
              <Button
                key={text}
                size="small"
                variant="outlined"
                color="inherit"
                disabled={busy || !drive}
                onClick={() => send(text)}
                sx={{ textTransform: 'none', borderRadius: 4 }}
              >
                {text}
              </Button>
            ))}
            {!drive && (
              <Typography variant="caption" color="text.secondary" sx={{ alignSelf: 'center' }}>
                Choose a drive to investigate it.
              </Typography>
            )}
          </Stack>
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
        </>
      }
    >
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
      {drive ? (
        <DriveItems
          key={drive.id}
          settings={settings}
          incident={incident}
          drive={drive}
          question={question}
          finding={finding}
          readsCurrent={readsCurrent}
          refresh={refreshIncident}
        />
      ) : (
        <OpenNotices chatId={chatId} incident={incident} />
      )}
    </ChatShell>
  );
}
