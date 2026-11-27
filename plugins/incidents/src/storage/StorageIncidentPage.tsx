import { SectionBox } from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import LinearProgress from '@mui/material/LinearProgress';
import Link from '@mui/material/Link';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import React from 'react';
import { Link as RouterLink, Redirect, useLocation, useParams } from 'react-router-dom';
import { useSettings } from '../data';
import { Settings } from '../model';
import { chatUrl, storageDriveUrl, storageUrl } from '../routes';
import { Capacity, CapacityHistory, size, time } from './Capacity';
import { ChildResults,driveLabel, ItemActions, ItemList, useLabel } from './Investigation';
import {
  Drive,
  DriveDetail,
  Item,
  mergeVerification,
  NodeScan,
  StorageIncident,
  useStorageDrive,
  useStorageIncident,
} from './storage-data';
import { StorageAlert } from './StorageAlert';
import { StorageNotices } from './StorageNotices';

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
  const chatId = incident.incident?.chatId;
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
              <Stack direction="row" justifyContent="space-between" gap={1} flexWrap="wrap">
                <Typography variant="caption" color="text.secondary">
                  Last scan {time(drive.scannedAt)}
                </Typography>
                {chatId && (
                  <Link component={RouterLink} to={chatUrl(chatId, { drive: drive.id })} variant="caption">
                    Investigate in chat
                  </Link>
                )}
              </Stack>
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
  chatId,
}: {
  detail: DriveDetail;
  itemId: string;
  settings: Settings;
  refresh: () => void;
  chatId?: string;
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
      {chatId && (
        <Paper variant="outlined" sx={panel}>
          <Typography variant="body2">
            Questions and cleanup approval for this drive are in the investigation chat.{' '}
            <Link component={RouterLink} to={chatUrl(chatId, { drive: detail.drive.id })}>
              Open the chat
            </Link>
          </Typography>
        </Paper>
      )}
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
  settings,
  incident,
  refreshIncident,
}: {
  id: string;
  itemId?: string;
  settings: Settings;
  incident: StorageIncident;
  refreshIncident: () => void;
}) {
  const { data, error, loading, refresh } = useStorageDrive(settings, id);
  const refreshAll = () => {
    refresh();
    refreshIncident();
  };
  const chatId = incident.incident?.chatId;
  const open = incident.notices.filter(notice => notice.driveId === id);

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
                {itemId ? (
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
          {itemId ? (
            <ItemDetail
              key={itemId}
              detail={data}
              itemId={itemId}
              settings={settings}
              refresh={refreshAll}
              chatId={chatId}
            />
          ) : (
            <>
              {chatId && (
                <Paper variant="outlined" sx={panel}>
                  <Stack
                    direction={{ xs: 'column', sm: 'row' }}
                    gap={1.5}
                    justifyContent="space-between"
                    alignItems={{ sm: 'center' }}
                  >
                    <Stack spacing={0.25}>
                      <Typography component="h2" variant="h6">
                        Investigate in chat
                      </Typography>
                      <Typography variant="body2" color="text.secondary">
                        {data.questions.filter(q => !q.answer).length} unanswered{' '}
                        {data.questions.filter(q => !q.answer).length === 1 ? 'question' : 'questions'}
                        {' · '}
                        {data.items.filter(item => item.eligible).length} eligible for cleanup
                        {open.length > 0 && ` · ${open.length} open ${open.length === 1 ? 'notice' : 'notices'}`}
                      </Typography>
                    </Stack>
                    <Button
                      component={RouterLink}
                      to={chatUrl(chatId, { drive: id })}
                      variant="contained"
                    >
                      Open the investigation chat
                    </Button>
                  </Stack>
                </Paper>
              )}
              <Paper variant="outlined" sx={panel}>
                <CapacityHistory snapshots={data.history} />
              </Paper>
              <Paper variant="outlined" sx={panel}>
                <ConsumerGroups items={data.items} driveId={id} />
              </Paper>
            </>
          )}
        </>
      )}
    </Stack>
  );
}

/**
 * A notification of an earlier release links to a drive question or finding. Those items now live in the one chat,
 * so the old link opens the chat on the same item. The old link keeps working.
 */
function ActionRedirect({ action }: { action: 'question' | 'cleanup' }) {
  const { driveId, actionId } = useParams<{ driveId?: string; actionId?: string }>();
  const settings = useSettings();
  const incident = useStorageIncident(settings);
  const chatId = incident.data?.incident?.chatId;
  if (chatId && driveId && actionId) {
    return (
      <Redirect
        to={chatUrl(chatId, { drive: driveId, [action === 'question' ? 'question' : 'finding']: actionId })}
      />
    );
  }
  if (!incident.loading && incident.data && !chatId) {
    return <StorageAlert severity="info">Storage incidents are disabled.</StorageAlert>;
  }
  return incident.error ? (
    <StorageAlert severity="error">{incident.error}</StorageAlert>
  ) : (
    <LinearProgress aria-label="Opening the storage chat" />
  );
}

/** The storage chat of an earlier release opened at `/incidents/storage/chat/<id>`. The chat is in the Chat tab now. */
export function StorageChatRedirect() {
  const { chatId } = useParams<{ chatId?: string }>();
  const drive = new URLSearchParams(useLocation().search).get('drive') ?? undefined;
  return <Redirect to={chatUrl(chatId, drive ? { drive } : {})} />;
}

export function StorageQuestionPage() {
  return <ActionRedirect action="question" />;
}

export function StorageFindingPage() {
  return <ActionRedirect action="cleanup" />;
}

export function StorageIncidentPage() {
  const { driveId, itemId } = useParams<{ driveId?: string; itemId?: string }>();
  const settings = useSettings();
  const incident = useStorageIncident(settings);
  const chatId = incident.data?.incident?.chatId;
  const isOverview = !driveId;

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
          {chatId && (
            <Button
              component={RouterLink}
              to={chatUrl(chatId, driveId ? { drive: driveId } : {})}
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
                settings={settings}
                incident={incident.data}
                refreshIncident={incident.refresh}
              />
            )}
          </>
        )}
      </Stack>
    </SectionBox>
  );
}
