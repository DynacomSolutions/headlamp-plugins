import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@kinvolk/headlamp-plugin/lib', () => ({
  Router: {
    createRouteURL: (name: string, p?: { id?: string }) => `/c/test/${name}/${p?.id ?? ''}`,
  },
}));

import { DiagnosesTable } from './DiagnosesTable';
import { DiagnosisSummary } from './model';

const d = (id: string, resolved: boolean): DiagnosisSummary => ({
  id,
  createdAt: '2026-11-19T10:00:00Z',
  status: 'done',
  source: 'webhook',
  alertName: `Alert${id}`,
  severity: 'critical',
  likelyCause: 'cause',
  confidence: 'high',
  resolved,
});

describe('DiagnosesTable', () => {
  it('has no checkbox column without a selection (the dashboard list)', () => {
    render(
      <MemoryRouter>
        <DiagnosesTable rows={[d('1', false)]} />
      </MemoryRouter>
    );
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
  });

  it('keeps the resolved state visible when a narrow table drops its columns', () => {
    render(
      <MemoryRouter>
        <DiagnosesTable rows={[d('1', true), d('2', false)]} compact />
      </MemoryRouter>
    );
    expect(screen.queryByRole('columnheader', { name: 'Resolved' })).toBeNull();
    expect(screen.getAllByText('resolved')).toHaveLength(1);
    // Confidence and source have no column, so they sit under the cause.
    expect(screen.getAllByText('high confidence, webhook')).toHaveLength(2);
    // Time, severity and status stay.
    for (const h of ['Time', 'Severity', 'Status'])
      expect(screen.getByRole('columnheader', { name: h })).toBeTruthy();
  });

  it('words a skipped incident as Not investigated in the status chip, wide and narrow', () => {
    const skipped = { ...d('3', false), status: 'skipped' as const };
    const { unmount } = render(
      <MemoryRouter>
        <DiagnosesTable rows={[skipped]} />
      </MemoryRouter>
    );
    expect(screen.getByText('Not investigated')).toBeTruthy();
    expect(screen.queryByText('skipped')).toBeNull();
    unmount();
    render(
      <MemoryRouter>
        <DiagnosesTable rows={[skipped]} narrow compact />
      </MemoryRouter>
    );
    expect(screen.getByText('Not investigated')).toBeTruthy();
    expect(screen.queryByText('skipped')).toBeNull();
  });

  it('stacks to three columns in a narrow place and keeps every fact', () => {
    render(
      <MemoryRouter>
        <DiagnosesTable rows={[d('1', true)]} narrow compact />
      </MemoryRouter>
    );
    expect(screen.getAllByRole('columnheader').map(h => h.textContent)).toEqual(['Time', 'Alert', 'Status']);
    expect(screen.getByText('critical')).toBeTruthy();
    expect(screen.getByText('done')).toBeTruthy();
    expect(screen.getByText('cause')).toBeTruthy();
    expect(screen.getByText('resolved')).toBeTruthy();
    expect(screen.getByText('high confidence, webhook')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Alert1' })).toBeTruthy();
  });

  it('shows all nine columns and the Run again button in a wide place', () => {
    render(
      <MemoryRouter>
        <DiagnosesTable
          rows={[{ ...d('1', true), status: 'failed' }]}
          onRerun={async () => undefined}
          selection={{ ids: [], onToggle: vi.fn(), onToggleAll: vi.fn() }}
        />
      </MemoryRouter>
    );
    expect(
      screen
        .getAllByRole('columnheader')
        .map(h => h.textContent)
        .filter(Boolean)
    ).toEqual([
      'Time',
      'Alert',
      'Severity',
      'Status',
      'Likely cause',
      'Confidence',
      'Source',
      'Resolved',
      'Actions',
    ]);
    expect(screen.getByRole('button', { name: 'Run again: Alert1' })).toBeTruthy();
    expect(screen.queryByText('high confidence, webhook')).toBeNull();
  });

  it('reports the toggles of the header and row checkboxes', () => {
    const onToggle = vi.fn();
    const onToggleAll = vi.fn();
    render(
      <MemoryRouter>
        <DiagnosesTable
          rows={[d('1', false), d('2', false)]}
          selection={{ ids: ['1'], onToggle, onToggleAll }}
        />
      </MemoryRouter>
    );
    const all = screen.getByRole('checkbox', {
      name: 'Select all shown incidents',
    }) as HTMLInputElement;
    expect(all.getAttribute('data-indeterminate')).toBe('true');
    fireEvent.click(all);
    expect(onToggleAll).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Alert2' }), { shiftKey: true });
    expect(onToggle).toHaveBeenCalledWith('2', true);
  });
});
