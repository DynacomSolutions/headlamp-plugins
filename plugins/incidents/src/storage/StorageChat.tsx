/*
 * The storage investigation, as a chat in the one Incidents chat. It has the same frame as every chat. Its thread is the
 * transcript of the storage incident. Under the thread sit the open items of the chosen drive: the unanswered questions
 * and the cleanup plan with its approval card. The Storage tab keeps the drive overview and links here.
 *
 * URL: the chat is a path segment (`/incidents/chat/<chat id>`). The drive context and the item in focus are query
 * strings (`?drive=<id>&question=<id>` or `&finding=<id>`) and change with history replace, so Back leaves the chat.
 */
import { Icon } from '@iconify/react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import LinearProgress from '@mui/material/LinearProgress';
import Link from '@mui/material/Link';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import React from 'react';
import { Link as RouterLink, useHistory, useLocation } from 'react-router-dom';
import { A2uiRenderer } from '../a2ui';
import { useChats, useFavourites, useModels } from '../chat-data';
import { ChatSummary, cleanErrorText } from '../chat-model';
import { CardSection, chatButtonSx, Composer, ContextMeter, MessageView } from '../ChatParts';
import { ChatShell, useStickToBottom } from '../ChatShell';
import { useSettings } from '../data';
import { Settings } from '../model';
import { ModelPicker } from '../ModelPicker';
import { chatUrl, storageDriveUrl, storageUrl } from '../routes';
import { size } from './Capacity';
import { CleanupPlan, Receipts } from './CleanupPlan';
import { ChildResults, driveLabel, QuestionCard, useStorageAction } from './Investigation';
import {
  chatPath,
  Drive,
  loadStorageTranscriptBefore,
  postStorage,
  StorageChatMessage,
  StorageIncident,
  useStorageChat,
  useStorageDrive,
} from './storage-data';
import { StorageAlert } from './StorageAlert';
import { DeliveryLine } from './StorageNotices';

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
          <Button aria-disabled={busy || !canLoadEarlier} onClick={loadEarlier} sx={chatButtonSx}>
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
                      <Stack key={notice.id} spacing={0.25}>
                        <Link
                          component={RouterLink}
                          to={chatUrl(chatId, {
                            drive: notice.driveId,
                            question: notice.action.id,
                          })}
                        >
                          Open question from this message
                        </Link>
                        <DeliveryLine delivery={notice.delivery} />
                      </Stack>
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

  const unanswered = data ? data.questions.filter(q => !q.answer).length : 0;
  return (
    <Stack spacing={2} data-drive-items={drive.id}>
      {detail.error && (
        <StorageAlert
          severity="error"
          action={
            <Button onClick={detail.refresh} sx={chatButtonSx}>
              Retry
            </Button>
          }
        >
          {detail.error}
        </StorageAlert>
      )}
      {detail.loading && <LinearProgress aria-label="Loading drive" />}
      {data && (
        <>
          <CardSection
            icon="mdi:help-circle-outline"
            title="Questions"
            meta={`${unanswered} unanswered`}
            highlighted={!!question && data.questions.some(q => q.id === question)}
            cardRef={question ? focus : undefined}
          >
            {data.questions.length === 0 && (
              <Typography color="text.secondary">No questions yet.</Typography>
            )}
            {[...data.questions]
              .sort((a, b) => Number(!!a.answer) - Number(!!b.answer))
              .map(q => (
                <Box key={q.id} sx={{ '& + &': { borderTop: 1, borderColor: 'divider', pt: 1.5 } }}>
                  <QuestionCard question={q} settings={settings} refresh={refreshAll} />
                </Box>
              ))}
          </CardSection>
          <CardSection
            icon="mdi:broom"
            title="Cleanup plan"
            meta={`${data.items.filter(i => i.eligible).length} eligible`}
            highlighted={!!finding}
            cardRef={finding ? focus : undefined}
          >
            <CleanupPlan
              detail={data}
              canApply={canApply}
              settings={settings}
              refresh={refreshAll}
              titled={false}
            />
            {data.receipts.length > 0 && <Receipts detail={data} />}
          </CardSection>
          <CardSection
            icon="mdi:text-box-search-outline"
            title="Investigation results"
            meta={String(data.children.length)}
            defaultOpen={data.children.length > 0}
          >
            <ChildResults detail={data} titled={false} />
          </CardSection>
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
    <CardSection
      icon="mdi:bell-outline"
      title="Findings and questions"
      meta={String(incident.notices.length)}
    >
      {incident.notices.map(notice => {
        const drive = incident.drives.find(d => d.id === notice.driveId);
        if (!drive || !notice.action) return null;
        return (
          <Stack
            key={notice.id}
            spacing={0.25}
            sx={{ '& + &': { borderTop: 1, borderColor: 'divider', pt: 1.5 } }}
          >
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
            <DeliveryLine delivery={notice.delivery} />
          </Stack>
        );
      })}
    </CardSection>
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
  // The same model and identity picker, favourites and context meter as every chat.
  const models = useModels(settings);
  const [favourites, toggleFavourite] = useFavourites();
  const [picked, setPicked] = React.useState<string | null>(null);
  const model = picked ?? models.data?.default ?? '';
  const modelOption = models.data?.models.find(m => m.id === model);
  const pickedOption = picked ? models.data?.models.find(m => m.id === picked) : undefined;
  const send = (text: string) =>
    run(() =>
      postStorage(settings, `${chatPath(chatId)}/messages`, {
        text,
        ...(drive ? { driveId: drive.id } : {}),
        ...(picked ? { model: picked } : {}),
        ...(pickedOption?.identityListed ? { identity: pickedOption.route } : {}),
      })
    );
  const messages = chat.data?.messages ?? [];
  // A link that names an item shows that item: the thread does not jump to the bottom then.
  const scroll = useStickToBottom(messages, !(question || finding));
  // The context changes the view, not the history: the query is replaced.
  const setDrive = (id?: string) => history.replace(chatUrl(chatId, id ? { drive: id } : {}));
  const [driveMenu, setDriveMenu] = React.useState<HTMLElement | null>(null);

  return (
    <ChatShell
      chats={list}
      activeId={chatId}
      onDelete={() => undefined}
      wide
      header={
        <Stack spacing={0.5} sx={{ minWidth: 0 }}>
          <Typography component="h1" variant="subtitle2" fontWeight={600} noWrap>
            Storage investigation
          </Typography>
          {/* The storage context is a row of chips, not a form. It scrolls sideways on a phone. */}
          <Stack
            direction="row"
            gap={0.75}
            alignItems="center"
            data-storage-context
            sx={{ overflowX: 'auto', scrollbarWidth: 'none', '&::-webkit-scrollbar': { display: 'none' }, pb: 0.25 }}
          >
            <Chip
              clickable
              size="small"
              variant="outlined"
              icon={<Icon icon="mdi:harddisk" width={16} height={16} />}
              onClick={event => setDriveMenu(event.currentTarget)}
              aria-haspopup="menu"
              aria-label={`Drive context: ${drive ? driveLabel(drive) : 'All drives'}`}
              label={
                <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
                  {drive ? driveLabel(drive) : 'All drives'}
                  <Icon icon="mdi:chevron-down" width={16} height={16} />
                </Box>
              }
              sx={{ flexShrink: 0, color: 'text.primary' }}
            />
            {drive && (
              <Chip
                size="small"
                variant="outlined"
                label={`${size(drive.availableBytes)} free`}
                sx={{ flexShrink: 0, color: 'text.secondary' }}
              />
            )}
            <Chip
              clickable
              size="small"
              variant="outlined"
              component={RouterLink}
              to={drive ? storageDriveUrl(drive.id) : storageUrl()}
              label={drive ? 'Open drive' : 'Storage overview'}
              sx={{ flexShrink: 0 }}
            />
            <Menu
              anchorEl={driveMenu}
              open={!!driveMenu}
              onClose={() => setDriveMenu(null)}
              MenuListProps={{ 'aria-label': 'Drive context' }}
            >
              <MenuItem
                selected={!drive}
                onClick={() => {
                  setDriveMenu(null);
                  setDrive(undefined);
                }}
              >
                All drives
              </MenuItem>
              {incident.drives.map(d => (
                <MenuItem
                  key={d.id}
                  selected={d.id === drive?.id}
                  onClick={() => {
                    setDriveMenu(null);
                    setDrive(d.id);
                  }}
                >
                  {driveLabel(d)}
                </MenuItem>
              ))}
            </Menu>
          </Stack>
        </Stack>
      }
      scroll={scroll}
      footer={
        <>
          {error && <StorageAlert severity="error">{error}</StorageAlert>}
          {/* The quick investigations: one row that scrolls sideways, so a phone keeps its height. */}
          <Stack
            direction="row"
            gap={1}
            alignItems="center"
            data-quick-investigations
            sx={{ overflowX: 'auto', scrollbarWidth: 'none', '&::-webkit-scrollbar': { display: 'none' } }}
          >
            {QUICK_INVESTIGATIONS.map(text => (
              <Button
                key={text}
                size="small"
                variant="outlined"
                color="inherit"
                disabled={busy || !drive}
                onClick={() => send(text)}
                sx={{ ...chatButtonSx, flexShrink: 0 }}
              >
                {text}
              </Button>
            ))}
            {!drive && (
              <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0 }}>
                Choose a drive to investigate it.
              </Typography>
            )}
          </Stack>
          <Composer
            running={busy}
            disabled={!chat.data || busy}
            onSend={send}
            picker={
              <ModelPicker
                models={models.data?.models ?? []}
                value={model}
                onChange={setPicked}
                favourites={favourites}
                onToggleFavourite={toggleFavourite}
                disabled={busy}
              />
            }
            meter={<ContextMeter used={0} window={modelOption?.contextWindow} />}
            placeholder="Ask what is using space or what changed"
          />
        </>
      }
    >
      {chat.loading && <LinearProgress aria-label="Loading storage chat" />}
      {chat.error && (
        <StorageAlert
          severity="error"
          action={
            <Button onClick={chat.refresh} sx={chatButtonSx}>
              Retry
            </Button>
          }
        >
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
