import { render, screen, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../model';
import { CleanupPlan, Receipts } from './CleanupPlan';
import type { DriveDetail, Item, Plan, Receipt } from './storage-data';

vi.mock('@kinvolk/headlamp-plugin/lib', () => ({
  ApiProxy: {},
  ConfigStore: class {},
}));
vi.mock('../LaunchPages', () => ({ useNow: () => Date.now() }));

const scannedAt = new Date().toISOString();
const plan: Plan = {
  id: 'plan-1',
  createdAt: scannedAt,
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  items: ['Build cache', 'Old cache', 'Queued cache', 'Unselected cache'].map(label => ({
    itemId: label,
    label,
    category: 'cache',
    bytes: 16_384,
    eligible: true,
    reason: '',
  })),
};

const items = plan.items.map<Item>(({ itemId, ...item }) => ({ ...item, id: itemId }));
const snapshot = {
  id: 'scan-1',
  scannedAt,
  totalBytes: 131_072,
  availableBytes: 65_536,
  reserveBytes: 32_768,
  complete: true,
};

const detail: DriveDetail = {
  drive: { ...snapshot, id: 'drive-1', node: 'worker-1', mount: '/', filesystemId: 'fs-1', status: 'healthy' },
  current: snapshot,
  history: [snapshot],
  items: items.map(item => item.id === 'Build cache' ? { ...item, eligible: false } : item),
  evidence: [],
  decisions: [],
  questions: [],
  children: [],
  plans: [plan],
  receipts: [],
};

function receipt(itemId: string, status: Receipt['status'], reason: string, bytes: number): Receipt {
  return { id: itemId, planId: plan.id, itemId, status, reason, bytes, updatedAt: scannedAt };
}

function renderCleanup(receipts: Receipt[]) {
  const data = { ...detail, receipts };
  render(
    <>
      <CleanupPlan detail={data} settings={DEFAULT_SETTINGS} canApply refresh={vi.fn()} />
      <Receipts detail={data} />
    </>
  );
}

it('shows persisted mixed outcomes and prevents repeat approval', () => {
  renderCleanup([
    receipt('Build cache', 'partial', 'needs-intervention:host-process-or-bind-mount', 4096),
    receipt('Old cache', 'removed', 'removed', 16_384),
    receipt('Queued cache', 'queued', 'Awaiting verified scanner receipt', 0),
  ]);

  const summary = screen.getByRole('alert');
  expect(summary.classList.contains('MuiAlert-colorWarning')).toBe(true);
  expect(within(summary).getByText(/3 of 4 plan items approved/).textContent).toContain(
    '1 removed. 1 need intervention. 1 queued and paused.'
  );
  const rows = screen.getAllByRole('listitem');
  expect(within(rows[0]).getByText('Partial · Needs intervention')).toBeDefined();
  expect(within(rows[1]).getByText('Removed')).toBeDefined();
  expect(within(rows[2]).getByText('Queued · Paused')).toBeDefined();
  expect(within(rows[3]).getByText('Not approved')).toBeDefined();
  expect(screen.getAllByText('Partial · Needs intervention')).toHaveLength(2);
  expect(screen.getByText(/A host process or bind mount was detected during cleanup/)).toBeDefined();
  expect(screen.getByText(/Build cache · 4,096 bytes of verified allocated data unlinked/)).toBeDefined();
  expect(screen.getAllByText('Queued · Paused')).toHaveLength(2);
  expect(screen.getByText(/Paused because another item in this approval needs intervention/)).toBeDefined();
  expect(screen.queryByRole('button', { name: /(?:review|retry).*approval/i })).toBeNull();
  expect(screen.queryByRole('checkbox')).toBeNull();
});

it('shows a successful subset as a subset of the plan', () => {
  renderCleanup([receipt('Old cache', 'removed', 'removed', 16_384)]);
  const summary = screen.getByRole('alert');
  expect(summary.classList.contains('MuiAlert-colorInfo')).toBe(true);
  expect(summary.textContent).toContain('1 of 4 plan items approved. 1 removed.');
});
