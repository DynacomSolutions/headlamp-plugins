import Link from '@mui/material/Link';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import React from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { notificationsUrl, storageFindingUrl, storageQuestionUrl } from '../routes';
import { driveLabel } from './Investigation';
import {
  NoticeAction,
  NoticeDelivery,
  NotificationCoverage,
  StorageIncident,
} from './storage-data';
import { StorageAlert } from './StorageAlert';

export function noticeUrl(action: NoticeAction) {
  return action.kind === 'question'
    ? storageQuestionUrl(action.driveId, action.id)
    : storageFindingUrl(action.driveId, action.id);
}

const deliveryLabels = {
  private: 'Available in Headlamp only',
  disabled: 'Storage push is disabled',
  authority_unavailable: 'Storage notification authority unavailable',
  no_recipients: 'No eligible device enrolments',
  revoked: 'Device enrolment access was withdrawn',
  pending: 'Send pending',
  accepted: 'Push provider accepted the send',
  failed: 'Push send failed',
  partial: 'Some push sends failed',
};

export function DeliveryEvidence({ delivery }: { delivery?: NoticeDelivery }) {
  if (!delivery) {
    return (
      <Typography variant="body2" color="text.secondary">
        Send status unavailable
      </Typography>
    );
  }
  return (
    <Stack spacing={0.25}>
      <Typography variant="body2">{deliveryLabels[delivery.status]}</Typography>
      {delivery.targetedRecipients > 0 && (
        <Typography variant="caption" color="text.secondary">
          {delivery.targetedRecipients} targeted · {delivery.providerAccepted} accepted ·{' '}
          {delivery.failed} failed · {delivery.pending} pending
        </Typography>
      )}
      <Typography variant="caption" color="text.secondary">
        {typeof delivery.clientReceived !== 'number'
          ? 'Device receipt unverified'
          : `Device receipts confirmed: ${delivery.clientReceived}`}
      </Typography>
    </Stack>
  );
}

function Coverage({ coverage }: { coverage?: NotificationCoverage }) {
  if (coverage?.status === 'disabled') {
    return <StorageAlert severity="info">Storage push is disabled for this deployment.</StorageAlert>;
  }
  if (coverage?.status === 'unavailable') {
    return <StorageAlert severity="warning">Storage notification authority is unavailable.</StorageAlert>;
  }
  if (coverage?.status !== 'ready' || typeof coverage.registeredRecipients !== 'number') {
    return <StorageAlert severity="info">Storage notification coverage is unavailable.</StorageAlert>;
  }
  const count = coverage.registeredRecipients;
  const revoked = coverage.revokedRecipients ?? 0;
  if (count === 0) {
    return (
      <StorageAlert severity="warning">
        {revoked > 0
          ? 'Access was withdrawn for the remaining storage notification enrolments.'
          : 'No eligible device enrolments for storage notifications.'}{' '}
        <Link component={RouterLink} to={notificationsUrl()}>
          Manage notifications
        </Link>
      </StorageAlert>
    );
  }
  return (
    <Typography variant="body2" color="text.secondary">
      {count} eligible {count === 1 ? 'device' : 'devices'} for storage notifications
      {revoked > 0 && (' · ' + revoked + ' enrolments with withdrawn access')}
      {' · '}
      <Link component={RouterLink} to={notificationsUrl()}>
        Manage notifications
      </Link>
    </Typography>
  );
}

export function StorageNotices({
  incident,
  readsCurrent,
}: {
  incident: StorageIncident;
  readsCurrent: boolean;
}) {
  return (
    <Stack component="section" spacing={1.5} aria-labelledby="storage-notice-heading">
      <Typography id="storage-notice-heading" component="h2" variant="h6">
        Findings and questions
      </Typography>
      <Coverage coverage={readsCurrent ? incident.notifications : undefined} />
      {incident.notices.length === 0 && (
        <Typography variant="body2" color="text.secondary">
          No open findings or questions.
        </Typography>
      )}
      {incident.notices.map(notice => {
        const drive = incident.drives.find(drive => drive.id === notice.driveId);
        if (!drive || !notice.action) return null;
        return (
          <Paper key={notice.id} variant="outlined" sx={{ p: 1.5, overflowWrap: 'anywhere' }}>
            <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" gap={1}>
              <Stack spacing={0.25}>
                <Link component={RouterLink} to={noticeUrl(notice.action)} fontWeight={600}>
                  {notice.kind === 'question'
                    ? 'Review unanswered question'
                    : 'Review cleanup finding'}
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
