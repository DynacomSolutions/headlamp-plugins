/*
 * The frame of the one Incidents chat: the chat list (a rail on a wide screen, a drawer on a phone), the
 * scrolling thread and the composer area. Incident chats and the storage investigation both render in it.
 */
import { Icon } from '@iconify/react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Drawer from '@mui/material/Drawer';
import IconButton from '@mui/material/IconButton';
import Link from '@mui/material/Link';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import React from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { chatIncidentIds, ChatSummary, relativeTime } from './chat-model';
import { chatUrl } from './routes';
import { useFillHeight } from './useFillHeight';

/** The width of the chat list on a wide screen. A narrow screen opens the same list in a drawer. */
export const CHAT_RAIL_WIDTH = 192;

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

function ChatList(props: {
  chats: ChatSummary[] | null;
  activeId?: string;
  onDelete: (id: string) => void;
}) {
  const { chats, activeId, onDelete } = props;
  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        gap: 0.25,
        overflow: 'auto',
        flex: 1,
        minHeight: 0,
      }}
    >
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
            borderRadius: 1.5,
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
              sx={{ flex: 1, minWidth: 0, px: 1, py: 0.75 }}
            >
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                {c.kind === 'storage' && (
                  <Box component="span" aria-hidden sx={{ display: 'flex', color: 'text.secondary' }}>
                    <Icon icon="mdi:harddisk" width={16} height={16} />
                  </Box>
                )}
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
                {c.kind === 'storage' ? 'Storage' : relativeTime(c.updatedAt)}
                {chatIncidentIds(c).length > 1
                  ? ` · ${chatIncidentIds(c).length} incidents`
                  : ''}
              </Typography>
            </Link>
          </Tooltip>
          {c.kind === 'storage' ? (
            <Box sx={{ width: 24, mr: 0.25 }} />
          ) : (
            <IconButton
              className="chat-delete"
              size="small"
              aria-label={`Delete ${c.title || 'chat'}`}
              onClick={() => onDelete(c.id)}
              sx={{ p: 0.25, mr: 0.25 }}
            >
              <Icon icon="mdi:delete-outline" width={16} height={16} />
            </IconButton>
          )}
        </Box>
      ))}
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

export function ChatShell(props: {
  chats: ChatSummary[] | null;
  activeId?: string;
  onDelete: (id: string) => void;
  /** Shown in the bar above the thread, next to the Chats button. It stays hidden on a wide screen when `wide` is false. */
  header?: React.ReactNode;
  wide?: boolean;
  scroll: { ref: React.RefObject<HTMLDivElement>; onScroll: () => void };
  /** The thread: messages, cards. */
  children: React.ReactNode;
  /** Above the composer, and the composer itself. */
  footer: React.ReactNode;
}) {
  const { chats, activeId, onDelete, header, wide, scroll, children, footer } = props;
  const [drawerOpen, setDrawerOpen] = React.useState(false);
  const fill = useFillHeight();
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
        <ChatRail chats={chats} activeId={activeId} onDelete={onDelete} />
      </Box>
      {/*
        The Headlamp app bar sits above a drawer, so a drawer from the top edge opens under it and its first item is
        cut off. The Chats drawer is a proper modal instead: it sits above the app bar, has its own header with a
        close button, keeps clear of the screen notch, and its list scrolls inside it.
      */}
      <Drawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        sx={theme => ({ zIndex: theme.zIndex.modal })}
        PaperProps={
          {
            component: 'nav',
            'aria-label': 'Chats',
            sx: {
              width: 'min(300px, 88vw)',
              display: 'flex',
              flexDirection: 'column',
              gap: 0.75,
              p: 1,
              pt: 'max(8px, env(safe-area-inset-top))',
              pb: 'max(8px, env(safe-area-inset-bottom))',
              height: '100%',
              maxHeight: '100dvh',
              boxSizing: 'border-box',
            },
            // A tap on a chat link closes the drawer.
            onClick: (e: React.MouseEvent) => {
              if ((e.target as HTMLElement).closest('a')) setDrawerOpen(false);
            },
          } as any
        }
      >
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', px: 0.5, flexShrink: 0 }}>
          <Typography variant="subtitle1" component="h2" fontWeight={600}>
            Chats
          </Typography>
          <IconButton size="small" aria-label="Close chats" onClick={() => setDrawerOpen(false)}>
            <Icon icon="mdi:close" width={20} height={20} />
          </IconButton>
        </Box>
        <ChatRail chats={chats} activeId={activeId} onDelete={onDelete} />
      </Drawer>
      <Box sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <Box
          sx={{
            display: { xs: 'flex', md: wide ? 'flex' : 'none' },
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
          <Box sx={{ flex: 1, minWidth: 0, maxWidth: 800, mx: { md: 'auto' } }}>{header}</Box>
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
            {children}
          </Box>
        </Box>
        <Box sx={{ px: 2, pb: 2 }}>
          <Box sx={{ maxWidth: 800, mx: 'auto', display: 'flex', flexDirection: 'column', gap: 1 }}>
            {footer}
          </Box>
        </Box>
      </Box>
    </Box>
  );
}
