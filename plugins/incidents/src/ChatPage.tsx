import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Link from '@mui/material/Link';
import Typography from '@mui/material/Typography';
import React from 'react';
import { Link as RouterLink, useHistory, useParams } from 'react-router-dom';
import {
  cancelChat,
  createChat,
  deleteChat,
  sendMessage,
  useChat,
  useChats,
  useFavourites,
  useIncidentNames,
  useModels,
} from './chat-data';
import { chatIncidentIds, ChatSummary, cleanErrorText, EXAMPLE_PROMPTS } from './chat-model';
import { Composer, ContextMeter, latestContext, MessageView } from './ChatParts';
import { ChatShell, useStickToBottom } from './ChatShell';
import { useSettings } from './data';
import { DiagnosisSummary, severityColour } from './model';
import { ModelPicker } from './ModelPicker';
import { useChatPresence, usePushId } from './push-data';
import { chatUrl, diagnosisUrl } from './routes';
import { useStorageIncident } from './storage/storage-data';
import { StorageChatView, storageSummary } from './storage/StorageChat';

export { CHAT_RAIL_WIDTH, useStickToBottom } from './ChatShell';
export { Composer, MessageView } from './ChatParts';

export { EXAMPLE_PROMPTS } from './chat-model';

/* ---------- Linked incidents ---------- */

/** The alert name and the time of day, so two incidents of one alert have different chips. */
function chipLabel(id: string, names: Map<string, DiagnosisSummary>): string {
  const d = names.get(id);
  if (!d) return id;
  const t = new Date(d.createdAt);
  const time = Number.isNaN(t.getTime())
    ? ''
    : t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return [d.alertName || id, time].filter(Boolean).join(' \u00b7 ');
}

/** The incidents a chat is about. One incident reads as a sentence, several as a scrolling list. */
export function IncidentLinks({
  ids,
  names,
}: {
  ids: string[];
  names: Map<string, DiagnosisSummary>;
}) {
  if (ids.length === 0) return null;
  const label = (id: string) => names.get(id)?.alertName || id;
  if (ids.length === 1) {
    return (
      <Typography variant="caption" color="text.secondary">
        About incident{' '}
        <Link component={RouterLink} to={diagnosisUrl(ids[0])}>
          {label(ids[0])}
        </Link>
      </Typography>
    );
  }
  return (
    <Box data-chat-incidents>
      <Typography variant="caption" color="text.secondary" component="div">
        About {ids.length} incidents
      </Typography>
      <Box
        component="ul"
        aria-label="Incidents in this chat"
        sx={{
          listStyle: 'none',
          m: 0,
          p: 0,
          mt: 0.5,
          display: 'flex',
          flexWrap: 'wrap',
          gap: 0.5,
          maxHeight: 76,
          overflowY: 'auto',
        }}
      >
        {ids.map(id => (
          <Box component="li" key={id} sx={{ maxWidth: '100%', display: 'flex' }}>
            <Chip
              component={RouterLink}
              to={diagnosisUrl(id)}
              clickable
              size="small"
              variant="outlined"
              color={severityColour(names.get(id)?.severity ?? '')}
              label={chipLabel(id, names)}
              title={names.get(id)?.likelyCause || id}
              sx={{ maxWidth: '100%' }}
            />
          </Box>
        ))}
      </Box>
    </Box>
  );
}

/* ---------- Page ---------- */

/**
 * The one chat page. The storage investigation is a chat too: when the id is the storage chat of the incident, the
 * same frame shows its transcript and its open items. Keyed by chat id, so the picked model and errors reset.
 */
export function ChatPage() {
  const { id } = useParams<{ id?: string }>();
  const settings = useSettings();
  const storage = useStorageIncident(settings);
  const storageChatId = storage.data?.enabled ? storage.data.incident?.chatId : undefined;
  // The storage chat is not in the agent's chat list: its id is known only once the storage incident has answered.
  if (id && !storage.data && storage.loading) {
    return (
      <Box sx={{ p: 4, display: 'flex', justifyContent: 'center' }}>
        <CircularProgress aria-label="Loading" />
      </Box>
    );
  }
  if (id && storageChatId === id && storage.data) {
    return (
      <StorageChatView
        key={id}
        chatId={id}
        incident={storage.data}
        refreshIncident={storage.refresh}
        readsCurrent={!storage.error}
      />
    );
  }
  return <ChatView key={id ?? 'new'} id={id} storageEntry={storage.data ? storageSummary(storage.data) : undefined} />;
}

/** The chat list: the agent's chats, with the storage investigation pinned first when storage is on. */
export function useChatList(settings: ReturnType<typeof useSettings>, storageEntry?: ChatSummary) {
  const chats = useChats(settings);
  const list = React.useMemo(
    () => (chats.data ? (storageEntry ? [storageEntry, ...chats.data] : chats.data) : storageEntry ? [storageEntry] : null),
    [chats.data, storageEntry]
  );
  return { ...chats, list };
}

export function ChatView({ id, storageEntry }: { id?: string; storageEntry?: ChatSummary }) {
  const settings = useSettings();
  const history = useHistory();
  const models = useModels(settings);
  const chats = useChatList(settings, storageEntry);
  const chat = useChat(settings, id);
  const [favourites, toggleFavourite] = useFavourites();
  const [picked, setPicked] = React.useState<string | null>(null);
  const [sendError, setSendError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  // Which device asked, and whether this page shows the chat: the agent pushes an answer only when it does not.
  const pushId = usePushId();
  useChatPresence(settings, id, pushId);

  const linkedIds = chat.data ? chatIncidentIds(chat.data) : [];
  const incidentNames = useIncidentNames(settings, linkedIds);
  const messages = chat.data?.messages ?? [];
  const running = !!chat.data?.running;
  // Derived for display: the pick wins, then the model that answered, then the agent default.
  // Only a pick is sent as a model. Without one the agent applies its default order (with a fallback by usage).
  const model = picked ?? chat.data?.model ?? models.data?.default ?? '';
  const modelOption = models.data?.models.find(m => m.id === model);
  // The identity goes with a pick, so the agent answers from the identity the person chose.
  const pickedOption = picked ? models.data?.models.find(m => m.id === picked) : undefined;
  const pickedIdentity = pickedOption?.identityListed ? pickedOption.route : undefined;
  const scroll = useStickToBottom(messages);
  const context = latestContext(messages);

  // The list is polled slowly: refresh it when the open chat starts or stops running.
  const lastRunning = React.useRef<boolean | null>(null);
  const refreshChats = chats.refresh;
  React.useEffect(() => {
    if (!chat.data) return;
    if (lastRunning.current !== null && lastRunning.current !== running) refreshChats();
    lastRunning.current = running;
  }, [chat.data, running, refreshChats]);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setSendError(null);
    try {
      await work();
    } catch (e) {
      setSendError(cleanErrorText(e));
    } finally {
      setBusy(false);
    }
  };

  const onSend = (text: string) =>
    run(async () => {
      if (!id) {
        const newId = await createChat(
          settings,
          picked ? { model: picked, ...(pickedIdentity ? { identity: pickedIdentity } : {}) } : {}
        );
        try {
          await sendMessage(settings, newId, text, undefined, pushId);
        } finally {
          chats.refresh();
          history.push(chatUrl(newId));
        }
        return;
      }
      await sendMessage(settings, id, text, picked ?? undefined, pushId, pickedIdentity);
      setPicked(null);
      chat.refresh();
      chats.refresh();
    });

  const onStop = () =>
    run(async () => {
      if (id) await cancelChat(settings, id);
      chat.refresh();
      chats.refresh();
    });

  const onDelete = (chatId: string) =>
    run(async () => {
      await deleteChat(settings, chatId);
      chats.refresh();
      if (chatId === id) history.push(chatUrl());
    });

  const picker = (
    <ModelPicker
      models={models.data?.models ?? []}
      value={model}
      onChange={setPicked}
      favourites={favourites}
      onToggleFavourite={toggleFavourite}
      disabled={running}
    />
  );
  const meter = <ContextMeter used={context.used} window={context.window ?? modelOption?.contextWindow} />;

  const loadError = chat.error || models.error;
  return (
    <ChatShell
      chats={chats.list}
      activeId={id}
      onDelete={onDelete}
      wide={linkedIds.length > 0}
      header={<IncidentLinks ids={linkedIds} names={incidentNames} />}
      scroll={scroll}
      footer={
        <>
          {loadError && <Alert severity="error">Could not load the chat: {loadError}</Alert>}
          {sendError && (
            <Alert severity="error" onClose={() => setSendError(null)}>
              {sendError}
            </Alert>
          )}
          <Composer
            running={running}
            disabled={busy}
            onSend={onSend}
            onStop={onStop}
            picker={picker}
            meter={meter}
          />
        </>
      }
    >
      {id && chat.loading && !chat.data && <CircularProgress aria-label="Loading" />}
      {!id && (
        <Box
          sx={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 2,
            textAlign: 'center',
          }}
        >
          <Typography variant="h5" component="h2">
            What do you want to know about the cluster?
          </Typography>
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, justifyContent: 'center' }}>
            {EXAMPLE_PROMPTS.map(p => (
              <Button
                key={p}
                size="small"
                variant="outlined"
                color="inherit"
                disabled={busy}
                onClick={() => onSend(p)}
                sx={{ textTransform: 'none', borderRadius: 4 }}
              >
                {p}
              </Button>
            ))}
          </Box>
        </Box>
      )}
      {messages.map(m => (
        <MessageView key={m.id} m={m} />
      ))}
    </ChatShell>
  );
}
