/*
 * "Chats about this incident": the chat threads linked to one incident, under the incident. A
 * thread about several incidents shows under each of them, with its number of incidents. The list
 * scrolls inside its own box. It shows nothing when the incident has no chat.
 */
import Box from '@mui/material/Box';
import Link from '@mui/material/Link';
import Typography from '@mui/material/Typography';
import React from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { useIncidentChats } from './chat-data';
import { chatIncidentIds, relativeTime } from './chat-model';
import { useSettings } from './data';
import { chatUrl } from './routes';

export function IncidentChats({ diagnosisId }: { diagnosisId: string }) {
  const settings = useSettings();
  const chats = useIncidentChats(settings, diagnosisId);
  const list = chats.data ?? [];
  if (list.length === 0) return null;
  return (
    <Box data-incident-chats sx={{ mb: 2 }}>
      <Typography variant="subtitle2" component="h2">
        Chats about this incident
      </Typography>
      <Box
        component="ul"
        aria-label="Chats about this incident"
        sx={{ listStyle: 'none', m: 0, p: 0, maxHeight: 160, overflowY: 'auto' }}
      >
        {list.map(c => {
          const n = chatIncidentIds(c).length;
          return (
            <Box
              component="li"
              key={c.id}
              sx={{ display: 'flex', gap: 1, alignItems: 'baseline', py: 0.25, minWidth: 0 }}
            >
              <Link
                component={RouterLink}
                to={chatUrl(c.id)}
                title={c.title || 'New chat'}
                sx={{
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {c.title || 'New chat'}
              </Link>
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{ flexShrink: 0, whiteSpace: 'nowrap' }}
              >
                {relativeTime(c.updatedAt)}
                {n > 1 ? ` · ${n} incidents` : ''}
              </Typography>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}
