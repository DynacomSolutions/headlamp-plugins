import { Icon } from '@iconify/react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import ButtonBase from '@mui/material/ButtonBase';
import CircularProgress from '@mui/material/CircularProgress';
import Collapse from '@mui/material/Collapse';
import IconButton from '@mui/material/IconButton';
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
  useModels,
} from './chat-data';
import { ChatMarkdown } from './chat-markdown';
import { ChatMessage, ChatSummary, cleanErrorText, relativeTime, Step } from './chat-model';
import { useSettings } from './data';
import { ModelPicker } from './ModelPicker';
import { chatUrl, diagnosisUrl } from './routes';

export const EXAMPLE_PROMPTS = [
  'Which pods are failing right now, and why?',
  'Summarise the most recent incidents.',
  'Are any nodes under memory or disk pressure?',
  'What changed in the cluster in the last hour?',
];

const errorText = cleanErrorText;

/** Space below an element that its ancestors keep (padding, border, margin). */
function spaceBelow(el: HTMLElement): number {
  let total = 0;
  for (let n: HTMLElement | null = el; n && n !== document.body; n = n.parentElement) {
    const cs = window.getComputedStyle(n);
    total += (parseFloat(cs.paddingBottom) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
    if (n !== el) total += parseFloat(cs.marginBottom) || 0;
  }
  return total;
}

/**
 * Height that fills the viewport below the element's top edge, minus the space the
 * surrounding layout keeps below it. Avoids hard-coding Headlamp's chrome height.
 */
function useFillHeight() {
  const [height, setHeight] = React.useState<number | null>(null);
  const [node, setNode] = React.useState<HTMLElement | null>(null);
  React.useEffect(() => {
    if (!node) return undefined;
    const measure = () => {
      const top = node.getBoundingClientRect().top;
      setHeight(Math.max(0, Math.floor(window.innerHeight - top - spaceBelow(node))));
    };
    measure();
    window.addEventListener('resize', measure);
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    ro?.observe(document.body);
    if (node.parentElement) ro?.observe(node.parentElement);
    return () => {
      window.removeEventListener('resize', measure);
      ro?.disconnect();
    };
  }, [node]);
  return { ref: setNode, height };
}

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
function useStickToBottom(signal: unknown) {
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

function Composer(props: {
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
            '&:hover .chat-delete, & .chat-delete:focus-visible': { opacity: 1 },
          })}
        >
          <Link
            component={RouterLink}
            to={chatUrl(c.id)}
            underline="none"
            color="inherit"
            aria-current={c.id === activeId ? 'page' : undefined}
            sx={{ flex: 1, minWidth: 0, px: 1, py: 0.75 }}
          >
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
              <Typography variant="body2" noWrap sx={{ flex: 1 }}>
                {c.title || 'New chat'}
              </Typography>
              {c.running && (
                <Box
                  role="status"
                  aria-label="Running"
                  sx={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: 'info.main' }}
                />
              )}
            </Box>
            <Typography variant="caption" color="text.secondary">
              {relativeTime(c.updatedAt)}
            </Typography>
          </Link>
          <IconButton
            className="chat-delete"
            size="small"
            aria-label={`Delete ${c.title || 'chat'}`}
            onClick={() => onDelete(c.id)}
          >
            <Icon icon="mdi:delete-outline" width={18} height={18} />
          </IconButton>
        </Box>
      ))}
    </Box>
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
          await sendMessage(settings, newId, text);
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
        picked && picked !== chat.data?.model ? picked : undefined
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
          width: { xs: 0, md: 260 },
          display: { xs: 'none', md: 'flex' },
          flexDirection: 'column',
          gap: 1,
          p: 1,
          flexShrink: 0,
          borderRight: `1px solid ${theme.palette.divider}`,
        })}
      >
        <Button
          component={RouterLink}
          to={chatUrl()}
          variant="outlined"
          color="inherit"
          startIcon={<Icon icon="mdi:plus" width={18} height={18} />}
          sx={{ justifyContent: 'flex-start', textTransform: 'none' }}
        >
          New chat
        </Button>
        <ChatList chats={chats.data} activeId={id} onDelete={onDelete} />
      </Box>
      <Box sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
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
            {chat.data?.diagnosisId && (
              <Typography variant="caption" color="text.secondary">
                About incident{' '}
                <Link component={RouterLink} to={diagnosisUrl(chat.data.diagnosisId)}>
                  {chat.data.diagnosisId}
                </Link>
              </Typography>
            )}
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
