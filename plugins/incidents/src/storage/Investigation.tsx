import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Link from '@mui/material/Link';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import React from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { A2uiRenderer } from '../a2ui';
import { cleanErrorText } from '../chat-model';
import { Settings } from '../model';
import { storageItemUrl } from '../routes';
import { size, time } from './Capacity';
import {
  DriveDetail,
  drivePath,
  Item,
  mergeVerification,
  postStorage,
  Question,
} from './storage-data';
import { StorageAlert } from './StorageAlert';

export function useStorageAction(refresh: () => void) {
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string>();
  const active = React.useRef(false);
  const run = async (action: () => Promise<unknown>) => {
    if (active.current) return false;
    active.current = true;
    setBusy(true);
    setError(undefined);
    try {
      await action();
      refresh();
      return true;
    } catch (error) {
      setError(cleanErrorText(error));
      return false;
    } finally {
      active.current = false;
      setBusy(false);
    }
  };
  return { busy, error, run };
}

export function driveLabel(drive: DriveDetail['drive']) {
  return `${drive.node} · ${drive.mount}`;
}

export function useLabel(item: Item) {
  if (item.inUse === true) return 'In use';
  return item.inUse === false ? 'Idle' : 'Use unknown';
}

export function ItemList({ items, driveId }: { items: Item[]; driveId: string }) {
  return (
    <Box component="ul" sx={{ listStyle: 'none', p: 0, m: 0 }}>
      {items.map(item => (
        <Box
          component="li"
          key={item.id}
          sx={{
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 1fr) auto',
            columnGap: 2,
            py: 1.25,
            borderBottom: 1,
            borderColor: 'divider',
            overflowWrap: 'anywhere',
          }}
        >
          <Stack spacing={0.25}>
            <Link component={RouterLink} to={storageItemUrl(driveId, item.id)} fontWeight={600}>
              {item.label}
            </Link>
            <Typography variant="body2" color="text.secondary">
              {item.category} · {useLabel(item)}
              {item.owner && ` · Owner ${item.owner}`}
              {item.holder && ` · Holder ${item.holder}`}
            </Typography>
            {(item.keep ||
              item.deferUntil ||
              item.reason ||
              mergeVerification(item) === 'unavailable') && (
              <Typography variant="caption" color="text.secondary">
                {item.keep && 'Kept until material change. '}
                {item.deferUntil && `Deferred until ${time(item.deferUntil)}. `}
                {mergeVerification(item) === 'unavailable'
                  ? 'Merge verification unavailable'
                  : item.reason}
              </Typography>
            )}
          </Stack>
          <Stack spacing={0.5} alignItems="flex-end">
            <Typography variant="body2" fontWeight={600}>
              {size(item.bytes)}
            </Typography>
            {item.eligible && mergeVerification(item) !== 'unavailable' && (
              <Chip size="small" variant="outlined" label="Eligible" />
            )}
          </Stack>
        </Box>
      ))}
    </Box>
  );
}

export function ItemActions({
  item,
  driveId,
  settings,
  refresh,
}: {
  item: Item;
  driveId: string;
  settings: Settings;
  refresh: () => void;
}) {
  const { busy, error, run } = useStorageAction(refresh);
  const [defer, setDefer] = React.useState(false);
  const [until, setUntil] = React.useState('');
  const untilDate = new Date(until);
  const path = drivePath(driveId);
  const sendDefer = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!(untilDate.getTime() > Date.now())) return;
    const saved = await run(() =>
      postStorage(settings, `${path}/decisions`, {
        itemId: item.id,
        decision: 'defer',
        until: untilDate.toISOString(),
      })
    );
    if (saved) {
      setDefer(false);
      setUntil('');
    }
  };
  return (
    <Stack spacing={1.5}>
      <Typography component="h2" variant="h6">
        Item actions
      </Typography>
      <Typography variant="body2" color="text.secondary">
        Keep protects the item until its size, owner or use changes. Defer protects it until the
        time you select.
      </Typography>
      <Stack direction="row" gap={1} flexWrap="wrap">
        <Button
          variant="outlined"
          disabled={busy || !!item.keep}
          onClick={() =>
            run(() =>
              postStorage(settings, `${path}/decisions`, {
                itemId: item.id,
                decision: 'keep',
              })
            )
          }
        >
          {item.keep ? 'Kept until material change' : 'Keep until material change'}
        </Button>
        <Button variant="outlined" disabled={busy} onClick={() => setDefer(value => !value)}>
          Defer
        </Button>
        <Button
          variant="outlined"
          disabled={busy}
          onClick={() =>
            run(() =>
              postStorage(settings, `${path}/investigate`, {
                kind: 'eligibility',
                itemId: item.id,
              })
            )
          }
        >
          Investigate item
        </Button>
      </Stack>
      {defer && (
        <Box
          component="form"
          onSubmit={sendDefer}
          sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}
        >
          <TextField
            required
            label="Defer until (local time)"
            type="datetime-local"
            size="small"
            value={until}
            InputLabelProps={{ shrink: true }}
            onChange={event => setUntil(event.target.value)}
          />
          <Button type="submit" disabled={busy || !(untilDate.getTime() > Date.now())}>
            Save deferral
          </Button>
        </Box>
      )}
      {busy && (
        <Typography variant="body2" role="status">
          Saving…
        </Typography>
      )}
      {error && <StorageAlert severity="error">{error}</StorageAlert>}
    </Stack>
  );
}

export function QuestionCard({
  question,
  settings,
  refresh,
}: {
  question: Question;
  settings: Settings;
  refresh: () => void;
}) {
  const [answer, setAnswer] = React.useState('');
  const { busy, error, run } = useStorageAction(refresh);
  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (answer.trim()) {
      run(() =>
        postStorage(settings, `/incident/questions/${encodeURIComponent(question.id)}/answer`, {
          answer: answer.trim(),
        })
      );
    }
  };
  return (
    <Stack spacing={1}>
      <Typography fontWeight={600}>{question.text}</Typography>
      {question.answer ? (
        <Typography variant="body2" color="text.secondary" sx={{ whiteSpace: 'pre-wrap' }}>
          {question.answer}
        </Typography>
      ) : (
        <Box component="form" onSubmit={submit} display="flex" gap={1} flexWrap="wrap">
          <TextField
            label="Answer"
            size="small"
            value={answer}
            inputProps={{ maxLength: 2000 }}
            onChange={event => setAnswer(event.target.value)}
            sx={{ flexGrow: 1 }}
          />
          <Button type="submit" disabled={busy || !answer.trim()}>
            Send answer
          </Button>
        </Box>
      )}
      {error && <StorageAlert severity="error">{error}</StorageAlert>}
    </Stack>
  );
}

export function ChildResults({
  detail,
  itemId,
  titled = true,
}: {
  detail: DriveDetail;
  itemId?: string;
  titled?: boolean;
}) {
  const evidence = itemId
    ? detail.evidence.filter(entry => entry.itemIds.includes(itemId))
    : detail.evidence;
  const ids = new Set(evidence.map(entry => entry.id));
  const children = itemId
    ? detail.children.filter(child => child.evidenceIds.some(id => ids.has(id)))
    : detail.children;
  return (
    <Stack spacing={1.5}>
      {titled && (
        <Typography component="h2" variant="h6">
          Investigation results
        </Typography>
      )}
      {children.length === 0 && <Typography color="text.secondary">No results yet.</Typography>}
      {children.map(child => (
        <Box
          key={child.id}
          component="details"
          sx={{ borderTop: 1, borderColor: 'divider', pt: 1 }}
        >
          <Box component="summary" sx={{ cursor: 'pointer', overflowWrap: 'anywhere' }}>
            {child.summary}
            <Typography variant="caption" color="text.secondary" sx={{ ml: 1 }}>
              {time(child.createdAt)}
            </Typography>
          </Box>
          <A2uiRenderer messages={child.a2ui} />
          {evidence
            .filter(entry => child.evidenceIds.includes(entry.id))
            .map(entry => (
              <Box component="ul" key={entry.id}>
                {entry.itemIds.map(id => {
                  const item = detail.items.find(item => item.id === id);
                  return (
                    item && (
                      <li key={id}>
                        <Link component={RouterLink} to={storageItemUrl(detail.drive.id, id)}>
                          {item.label}
                        </Link>
                      </li>
                    )
                  );
                })}
              </Box>
            ))}
        </Box>
      ))}
    </Stack>
  );
}
