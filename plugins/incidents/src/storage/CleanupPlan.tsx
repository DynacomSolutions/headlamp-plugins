import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControlLabel from '@mui/material/FormControlLabel';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import React from 'react';
import { cleanErrorText } from '../chat-model';
import { useNow } from '../LaunchPages';
import { Settings } from '../model';
import { size, time } from './Capacity';
import {
  DriveDetail,
  drivePath,
  Item,
  mergeVerification,
  Plan,
  postStorage,
  Receipt,
} from './storage-data';

export function CleanupPlan({
  detail,
  settings,
  canApply,
  refresh,
}: {
  detail: DriveDetail;
  settings: Settings;
  canApply: boolean;
  refresh: () => void;
}) {
  const [issued, setIssued] = React.useState<Plan>();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string>();
  const plan = [issued, ...detail.plans].reduce<Plan | undefined>(
    (newest, candidate) =>
      candidate && (!newest || candidate.createdAt > newest.createdAt) ? candidate : newest,
    undefined
  );
  const eligible = detail.items.filter(
    item => item.eligible && mergeVerification(item) !== 'unavailable'
  );
  const dryRun = async () => {
    setBusy(true);
    setError(undefined);
    try {
      setIssued(await postStorage<Plan>(settings, `${drivePath(detail.drive.id)}/dry-run`, {}));
      refresh();
    } catch (error) {
      setError(cleanErrorText(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Stack spacing={1.5}>
      <Typography component="h2" variant="h6">
        Cleanup plan
      </Typography>
      {!canApply && <Alert severity="info">Cleanup approval is unavailable for this drive.</Alert>}
      <Box>
        <Button
          variant="outlined"
          disabled={busy || !detail.drive.complete || eligible.length === 0}
          onClick={dryRun}
        >
          {busy ? 'Running dry run…' : `Dry run all eligible items (${eligible.length})`}
        </Button>
      </Box>
      {error && <Alert severity="error">{error}</Alert>}
      {plan && (
        <PlanReview
          key={plan.id}
          plan={plan}
          settings={settings}
          canApply={canApply}
          currentItems={detail.items}
          receipts={detail.receipts}
          refresh={refresh}
        />
      )}
    </Stack>
  );
}

function PlanReview({
  plan,
  settings,
  canApply,
  currentItems,
  receipts,
  refresh,
}: {
  plan: Plan;
  settings: Settings;
  canApply: boolean;
  currentItems: Item[];
  receipts: Receipt[];
  refresh: () => void;
}) {
  const [selected, setSelected] = React.useState<string[]>([]);
  const [submitted, setSubmitted] = React.useState<string[]>();
  const [result, setResult] = React.useState<Receipt[]>([]);
  const [confirm, setConfirm] = React.useState<string[]>();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string>();
  const now = useNow(true);
  const expired = !(Date.parse(plan.expiresAt) > now);
  const approved = result.length > 0 || receipts.some(receipt => receipt.planId === plan.id);
  const currentById = new Map(currentItems.map(item => [item.id, item]));
  const checks = plan.items.map(item => {
    const current = currentById.get(item.itemId);
    const frozenMerge = mergeVerification(item);
    const currentMerge = current && mergeVerification(current);
    const missingMerge =
      (frozenMerge !== undefined || currentMerge !== undefined) &&
      (frozenMerge !== 'verified' || currentMerge !== 'verified');
    return {
      item,
      missingMerge,
      selectable: item.eligible && !!current?.eligible && !missingMerge,
    };
  });
  const selectable = new Set(
    checks.filter(check => check.selectable).map(check => check.item.itemId)
  );
  const selection = selected.filter(id => selectable.has(id));
  const confirming = plan.items.filter(item => confirm?.includes(item.itemId));
  const bytes = confirming.reduce((sum, item) => sum + item.bytes, 0);
  const confirmReady = !!confirm?.length && confirm.every(id => selectable.has(id));
  const confirmMissingMerge = checks.some(
    ({ item, missingMerge }) => missingMerge && confirm?.includes(item.itemId)
  );
  const retryReady = !!submitted?.length && submitted.every(id => selectable.has(id));

  const change = (id: string, checked: boolean) =>
    setSelected(values => (checked ? [...values, id] : values.filter(value => value !== id)));

  const approve = async () => {
    if (busy || !canApply || approved || !(submitted ? retryReady : confirmReady)) return;
    if (!submitted && !(Date.parse(plan.expiresAt) > Date.now())) {
      setConfirm(undefined);
      return;
    }
    const itemIds = submitted ?? confirm;
    if (!itemIds) return;
    setSubmitted(itemIds);
    setBusy(true);
    setConfirm(undefined);
    setError(undefined);
    try {
      const response = await postStorage<{ receipts: Receipt[] }>(
        settings,
        `/incident/plans/${encodeURIComponent(plan.id)}/approve`,
        { itemIds }
      );
      setResult(response.receipts);
    } catch (error) {
      setError(cleanErrorText(error));
    } finally {
      setBusy(false);
      refresh();
    }
  };

  return (
    <Stack spacing={1.5}>
      <Box>
        <Typography fontWeight={600}>Dry run results</Typography>
        <Typography variant="body2" color="text.secondary">
          {time(plan.createdAt)} · Expires {time(plan.expiresAt)}
        </Typography>
      </Box>
      {approved && <Alert severity="success">Approval recorded. See cleanup receipts below.</Alert>}
      {expired && !approved && <Alert severity="warning">This plan has expired.</Alert>}
      <Box component="ul" sx={{ listStyle: 'none', p: 0, m: 0 }}>
        {checks.map(({ item, missingMerge, selectable }) => (
          <Box
            component="li"
            key={item.itemId}
            sx={{ py: 1, borderTop: 1, borderColor: 'divider', overflowWrap: 'anywhere' }}
          >
            {selectable && canApply && !approved ? (
              <FormControlLabel
                control={
                  <Checkbox
                    checked={selected.includes(item.itemId)}
                    disabled={expired || !!submitted || busy}
                    onChange={event => change(item.itemId, event.target.checked)}
                  />
                }
                label={`${item.label} · ${size(item.bytes)}`}
              />
            ) : (
              <Typography variant="body2">
                {item.label} · {size(item.bytes)}
              </Typography>
            )}
            <Typography variant="caption" color="text.secondary" display="block">
              {missingMerge
                ? 'Excluded · Merge verification unavailable'
                : item.eligible && !selectable
                ? 'Item changed since the dry run'
                : `${item.eligible ? 'Eligible' : 'Excluded'}${
                    item.reason ? ` · ${item.reason}` : ''
                  }`}
            </Typography>
          </Box>
        ))}
      </Box>
      {error && !approved && <Alert severity="error">{error}</Alert>}
      {!approved && canApply && (
        <Box>
          <Button
            color="error"
            variant="contained"
            disabled={busy || (submitted ? !retryReady : !selection.length || expired)}
            onClick={submitted ? approve : () => setConfirm(selection)}
          >
            {submitted ? 'Retry the same approval' : `Review approval (${selection.length})`}
          </Button>
        </Box>
      )}
      <Dialog open={!!confirm} onClose={() => setConfirm(undefined)} fullWidth maxWidth="xs">
        <DialogTitle>Approve selected items?</DialogTitle>
        <DialogContent>
          <Typography variant="body2">
            Approve {confirming.length} selected {confirming.length === 1 ? 'item' : 'items'} totalling{' '}
            {size(bytes)}. Each item is checked again before removal.
          </Typography>
          <Box component="ul" sx={{ overflowWrap: 'anywhere' }}>
            {confirming.map(item => (
              <li key={item.itemId}>{item.label}</li>
            ))}
          </Box>
          {!confirmReady && (
            <Alert severity="warning">
              {confirmMissingMerge
                ? 'Merge verification is unavailable for a selected item.'
                : 'A selected item is no longer eligible.'}{' '}
              Cancel and review the remaining eligible items.
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirm(undefined)}>Cancel</Button>
          <Button onClick={approve} disabled={expired || !canApply || !confirmReady} color="error">
            Approve and queue
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}

const receiptColours = {
  queued: 'info',
  removed: 'success',
  stale: 'warning',
  blocked: 'warning',
  failed: 'error',
} as const;

export function Receipts({ detail }: { detail: DriveDetail }) {
  return (
    <Stack spacing={1}>
      <Typography component="h2" variant="h6">
        Cleanup receipts
      </Typography>
      {detail.receipts.length === 0 && (
        <Typography color="text.secondary">No cleanup receipts yet.</Typography>
      )}
      {detail.receipts.map(receipt => {
        const item = detail.plans
          .find(plan => plan.id === receipt.planId)
          ?.items.find(item => item.itemId === receipt.itemId);
        return (
          <Box key={receipt.id} sx={{ borderTop: 1, borderColor: 'divider', pt: 1 }}>
            <Stack direction="row" gap={1} alignItems="center" flexWrap="wrap">
              <Chip size="small" label={receipt.status} color={receiptColours[receipt.status]} />
              <Typography variant="body2">
                {item?.label ?? 'Storage item'} · {size(receipt.bytes)}
              </Typography>
            </Stack>
            <Typography variant="caption" color="text.secondary">
              {time(receipt.updatedAt)}
              {receipt.reason && ` · ${receipt.reason}`}
            </Typography>
          </Box>
        );
      })}
    </Stack>
  );
}
