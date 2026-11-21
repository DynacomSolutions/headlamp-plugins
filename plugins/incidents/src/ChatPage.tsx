import { Icon } from '@iconify/react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import ButtonBase from '@mui/material/ButtonBase';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Collapse from '@mui/material/Collapse';
import Drawer from '@mui/material/Drawer';
import IconButton from '@mui/material/IconButton';
import Link from '@mui/material/Link';
import Tooltip from '@mui/material/Tooltip';
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
import { ChatMarkdown } from './chat-markdown';
import {
  chatIncidentIds,
  ChatMessage,
  ChatSummary,
  cleanErrorText,
  relativeTime,
  Step,
} from './chat-model';
import { useSettings } from './data';
import { DiagnosisSummary, severityColour } from './model';
import { ModelPicker } from './ModelPicker';
import { useChatPresence, usePushId } from './push-data';
import { chatUrl, diagnosisUrl } from './routes';
import { useFillHeight } from './useFillHeight';

/** The width of the chat list on a wide screen. A narrow screen opens the same list in a drawer. */
export const CHAT_RAIL_WIDTH = 192;

export const EXAMPLE_PROMPTS = [
  'Which pods are failing right now, and why?',
  'Summarise the most recent incidents.',
  'Are any nodes under memory or disk pressure?',
  'What changed in the cluster in the last hour?',
];

const errorText = cleanErrorText;

/* ---------- Thread ---------- */

function StepList({ steps, running }: { steps: Step[]; running: boolean }) {
  const [open, setOpen] = React.useState(false);
  const busy = running && steps.some(s => s.status === 'running');
  const label = busy
    ? 'Investigating...'
    : `Investigated ${steps.length} ${steps.length === 1 ? 'thing' : 'things'}`;
  return (
    <Box>
      <ButtonBase
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        sx={{ gap: 0.5, color: 'text.secondary', borderRadius: 1, py: 0.25 }}
      >
        {busy ? (
          <CircularProgress size={14} aria-label="Working" />
        ) : (
          <Icon icon={open ? 'mdi:chevron-down' : 'mdi:chevron-right'} width={18} height={18} />
        )}
        <Typography variant="body2">{label}</Typography>
      </ButtonBase>
      <Collapse in={open} unmountOnExit>
        <Box
          component="ul"
          sx={theme => ({
            listStyle: 'none',
            m: 0,
            mt: 0.5,
            ml: 1,
            pl: 1.5,
            borderLeft: `2px solid ${theme.palette.divider}`,
            display: 'flex',
            flexDirection: 'column',
            gap: 1,
          })}
        >
          {steps.map(s => (
            <Box
              component="li"
              key={s.id}
              sx={{ display: 'flex', gap: 1, alignItems: 'flex-start' }}
            >
              <Box sx={{ pt: '2px', display: 'flex' }}>
                {s.status === 'running' ? (
                  <CircularProgress size={14} aria-label="Running" />
                ) : s.ok === false ? (
                  <Box role="img" aria-label="Failed" sx={{ color: 'error.main', display: 'flex' }}>
                    <Icon icon="mdi:close-circle" width={16} height={16} />
                  </Box>
                ) : (
                  <Box
                    role="img"
                    aria-label="Succeeded"
                    sx={{ color: 'success.main', display: 'flex' }}
                  >
                    <Icon icon="mdi:check-circle" width={16} height={16} />
                  </Box>
                )}
              </Box>
              <Box sx={{ minWidth: 0 }}>
                <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
                  {s.tool}
                </Typography>
                {s.reason && (
                  <Typography variant="caption" color="text.secondary" component="div">
                    {s.reason}
                  </Typography>
                )}
                {s.summary && (
                  <Typography variant="caption" component="div" sx={{ wordBreak: 'break-word' }}>
                    {s.summary}
                  </Typography>
                )}
              </Box>
            </Box>
          ))}
        </Box>
      </Collapse>
    </Box>
  );
}

export function MessageView({ m }: { m: ChatMessage }) {
  if (m.role === 'user') {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Box
          sx={theme => ({
            maxWidth: '85%',
            px: 2,
            py: 1,
            borderRadius: 3,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            backgroundColor: theme.palette.action.selected,
          })}
        >
          <Typography variant="body1" component="div">
            {m.text}
          </Typography>
        </Box>
      </Box>
    );
  }
  const running = m.status === 'running';
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      {m.steps.length > 0 && <StepList steps={m.steps} running={running} />}
      {m.text && <ChatMarkdown source={m.text} />}
      {running && !m.text && m.steps.length === 0 && (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, color: 'text.secondary' }}>
          <CircularProgress size={14} aria-label="Thinking" />
          <Typography variant="body2">Thinking...</Typography>
        </Box>
      )}
      {m.status === 'failed' && <Alert severity="error">{m.error || 'The turn failed.'}</Alert>}
      {m.status === 'cancelled' && (
        <Typography variant="caption" color="text.secondary">
          Stopped.
        </Typography>
      )}
    </Box>
  );
}

/** Scrolls to the bottom when `signal` changes, unless the user scrolled up. */
export function useStickToBottom(signal: unknown) {
  const ref = React.useRef<HTMLDivElement | null>(null);
  const stick = React.useRef(true);
  const onScroll = () => {
    const el = ref.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };
  React.useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [signal]);
  return { ref, onScroll };
}

/* ---------- Composer ---------- */

export function Composer(props: {
  running: boolean;
  disabled?: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
  picker: React.ReactNode;
}) {
  const { running, disabled, onSend, onStop, picker } = props;
  const [text, setText] = React.useState('');
  const canSend = !running && !disabled && text.trim() !== '';
  const send = () => {
    if (!canSend) return;
    onSend(text.trim());
    setText('');
  };
  return (
    <Box
      sx={theme => ({
        border: `1px solid ${theme.palette.divider}`,
        borderRadius: 3,
        p: 1,
        display: 'flex',
        flexDirection: 'column',
        gap: 0.5,
        backgroundColor: theme.palette.background.paper,
      })}
    >
      <Box
        component="textarea"
        aria-label="Message"
        placeholder="Ask about the cluster or an incident"
        rows={2}
        maxLength={8000}
        value={text}
        onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setText(e.target.value)}
        onKeyDown={(e: React.KeyboardEvent) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            send();
          }
        }}
        sx={theme => ({
          resize: 'none',
          border: 'none',
          outline: 'none',
          background: 'transparent',
          color: theme.palette.text.primary,
          font: 'inherit',
          px: 1,
          py: 0.5,
          maxHeight: 200,
          overflow: 'auto',
        })}
      />
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        {picker}
        {running ? (
          <Button
            size="small"
            variant="contained"
            color="inherit"
            onClick={onStop}
            startIcon={<Icon icon="mdi:stop" width={16} height={16} />}
          >
            Stop
          </Button>
        ) : (
          <IconButton
            color="primary"
            size="small"
            aria-label="Send"
            disabled={!canSend}
            onClick={send}
          >
            <Icon icon="mdi:arrow-up-circle" width={28} height={28} />
          </IconButton>
        )}
      </Box>
    </Box>
  );
}

/* ---------- Chat list ---------- */

function ChatList(props: {
  chats: ChatSummary[] | null;
  activeId?: string;
  onDelete: (id: string) => void;
}) {
  const { chats, activeId, onDelete } = props;
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.25, overflow: 'auto', flex: 1 }}>
      {chats && chats.length === 0 && (
        <Typography variant="body2" color="text.secondary" sx={{ p: 1 }}>
          No chats yet.
        </Typography>
      )}
      {(chats ?? []).map(c => (
        <Box
          key={c.id}
          sx={theme => ({
            display: 'flex',
            alignItems: 'center',
            borderRadius: 1,
            backgroundColor: c.id === activeId ? theme.palette.action.selected : 'transparent',
            '&:hover': { backgroundColor: theme.palette.action.hover },
            '& .chat-delete': { opacity: 0 },
            '&:hover .chat-delete, & .chat-delete:focus-visible, &:focus-within .chat-delete': {
              opacity: 1,
            },
            // A touch screen has no hover: the delete button stays visible.
            '@media (hover: none)': { '& .chat-delete': { opacity: 1 } },
          })}
        >
          <Tooltip title={c.title || 'New chat'} placement="right" enterDelay={600}>
            <Link
              component={RouterLink}
              to={chatUrl(c.id)}
              underline="none"
              color="inherit"
              aria-current={c.id === activeId ? 'page' : undefined}
              sx={{ flex: 1, minWidth: 0, px: 1, py: 0.5 }}
            >
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                <Typography variant="body2" noWrap sx={{ flex: 1, minWidth: 0 }}>
                  {c.title || 'New chat'}
                </Typography>
                {c.running && (
                  <Box
                    role="status"
                    aria-label="Running"
                    sx={{
                      width: 8,
                      height: 8,
                      flexShrink: 0,
                      borderRadius: '50%',
                      backgroundColor: 'info.main',
                    }}
                  />
                )}
              </Box>
              <Typography variant="caption" color="text.secondary" noWrap component="div">
                {relativeTime(c.updatedAt)}
                {chatIncidentIds(c).length > 1
                  ? ` \u00b7 ${chatIncidentIds(c).length} incidents`
                  : ''}
              </Typography>
            </Link>
          </Tooltip>
          <IconButton
            className="chat-delete"
            size="small"
            aria-label={`Delete ${c.title || 'chat'}`}
            onClick={() => onDelete(c.id)}
            sx={{ p: 0.25, mr: 0.25 }}
          >
            <Icon icon="mdi:delete-outline" width={16} height={16} />
          </IconButton>
        </Box>
      ))}
    </Box>
  );
}

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

/** The New chat button and the chat list: the wide rail and the narrow drawer show the same thing. */
function ChatRail(props: {
  chats: ChatSummary[] | null;
  activeId?: string;
  onDelete: (id: string) => void;
}) {
  return (
    <>
      <Button
        component={RouterLink}
        to={chatUrl()}
        variant="outlined"
        color="inherit"
        size="small"
        startIcon={<Icon icon="mdi:plus" width={18} height={18} />}
        sx={{ justifyContent: 'flex-start', textTransform: 'none', flexShrink: 0 }}
      >
        New chat
      </Button>
      <ChatList chats={props.chats} activeId={props.activeId} onDelete={props.onDelete} />
    </>
  );
}

/* ---------- Page ---------- */

/** Keyed by chat id, so the picked model and errors reset when the chat changes. */
export function ChatPage() {
  const { id } = useParams<{ id?: string }>();
  return <ChatView key={id ?? 'new'} id={id} />;
}

export function ChatView({ id }: { id?: string }) {
  const settings = useSettings();
  const history = useHistory();
  const models = useModels(settings);
  const chats = useChats(settings);
  const chat = useChat(settings, id);
  const [favourites, toggleFavourite] = useFavourites();
  const [picked, setPicked] = React.useState<string | null>(null);
  const [sendError, setSendError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [drawerOpen, setDrawerOpen] = React.useState(false);
  // Which device asked, and whether this page shows the chat: the agent pushes an answer only when it does not.
  const pushId = usePushId();
  useChatPresence(settings, id, pushId);

  const linkedIds = chat.data ? chatIncidentIds(chat.data) : [];
  const incidentNames = useIncidentNames(settings, linkedIds);
  const messages = chat.data?.messages ?? [];
  const running = !!chat.data?.running;
  // Derived: the pick wins, then the chat's own model, then the agent default.
  const model = picked ?? chat.data?.model ?? models.data?.default ?? '';
  const scroll = useStickToBottom(messages);

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
      setSendError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const onSend = (text: string) =>
    run(async () => {
      if (!id) {
        const newId = await createChat(settings, model ? { model } : {});
        try {
          await sendMessage(settings, newId, text, undefined, pushId);
        } finally {
          chats.refresh();
          history.push(chatUrl(newId));
        }
        return;
      }
      await sendMessage(
        settings,
        id,
        text,
        picked && picked !== chat.data?.model ? picked : undefined,
        pushId
      );
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

  const fill = useFillHeight();
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

  const loadError = chat.error || models.error;
  return (
    <Box
      ref={fill.ref}
      sx={theme => ({
        display: 'flex',
        height: fill.height ?? 'calc(100vh - 140px)',
        minHeight: 420,
        border: `1px solid ${theme.palette.divider}`,
        borderRadius: 2,
        overflow: 'hidden',
        backgroundColor: theme.palette.background.default,
      })}
    >
      <Box
        component="nav"
        aria-label="Chats"
        sx={theme => ({
          width: { xs: 0, md: CHAT_RAIL_WIDTH },
          display: { xs: 'none', md: 'flex' },
          flexDirection: 'column',
          gap: 0.75,
          p: 0.75,
          flexShrink: 0,
          minWidth: 0,
          borderRight: `1px solid ${theme.palette.divider}`,
        })}
      >
        <ChatRail chats={chats.data} activeId={id} onDelete={onDelete} />
      </Box>
      <Drawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        PaperProps={
          {
            component: 'nav',
            'aria-label': 'Chats',
            sx: { width: 'min(280px, 85vw)', p: 1, gap: 0.75 },
            // A tap on a chat link closes the drawer.
            onClick: (e: React.MouseEvent) => {
              if ((e.target as HTMLElement).closest('a')) setDrawerOpen(false);
            },
          } as any
        }
      >
        <ChatRail chats={chats.data} activeId={id} onDelete={onDelete} />
      </Drawer>
      <Box sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <Box
          sx={{
            display: { xs: 'flex', md: linkedIds.length ? 'flex' : 'none' },
            alignItems: 'flex-start',
            gap: 1.5,
            px: 2,
            pt: 1,
            flex: 'none',
          }}
        >
          <Button
            size="small"
            variant="outlined"
            color="inherit"
            onClick={() => setDrawerOpen(true)}
            startIcon={<Icon icon="mdi:forum-outline" width={18} height={18} />}
            sx={{
              display: { xs: 'inline-flex', md: 'none' },
              textTransform: 'none',
              flexShrink: 0,
            }}
          >
            Chats
          </Button>
          <Box sx={{ flex: 1, minWidth: 0, maxWidth: 800, mx: { md: 'auto' } }}>
            <IncidentLinks ids={linkedIds} names={incidentNames} />
          </Box>
        </Box>
        <Box
          ref={scroll.ref}
          onScroll={scroll.onScroll}
          sx={{ flex: 1, overflow: 'auto', px: 2, py: 3 }}
        >
          <Box
            sx={{
              maxWidth: 800,
              mx: 'auto',
              display: 'flex',
              flexDirection: 'column',
              gap: 3,
              minHeight: '100%',
            }}
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
          </Box>
        </Box>
        <Box sx={{ px: 2, pb: 2 }}>
          <Box sx={{ maxWidth: 800, mx: 'auto', display: 'flex', flexDirection: 'column', gap: 1 }}>
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
            />
          </Box>
        </Box>
      </Box>
    </Box>
  );
}
