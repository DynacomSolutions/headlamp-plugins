import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@iconify/react', () => ({ Icon: (p: { icon: string }) => <i data-icon={p.icon} /> }));
vi.mock('@kinvolk/headlamp-plugin/lib', () => ({
  ApiProxy: { request: vi.fn(), streamResults: vi.fn() },
  K8s: { ResourceClasses: {} },
  Router: {
    createRouteURL: (name: string, p: Record<string, string>) =>
      `/${name}/${p.namespace}/${p.crName}`,
  },
}));

import { DEFAULT_REPORT, ReportConfig } from './config';
import { ReportBody } from './ReportBody';

afterEach(cleanup);

const pod = (name: string, ns: string, phase: string, restarts: number) => ({
  kind: 'Pod',
  metadata: { name, namespace: ns, uid: name },
  status: { phase, containerStatuses: [{ ready: true, restartCount: restarts }] },
});
const OBJECTS = [
  pod('a', 'prod', 'Running', 1),
  pod('b', 'prod', 'Pending', 2),
  pod('c', 'dev', 'Running', 3),
];
const scope = { namespaces: [], nodes: [] };
const show = (patch: Partial<ReportConfig>, objects = OBJECTS, kiosk = false) =>
  render(
    <MemoryRouter>
      <ReportBody
        objects={objects}
        config={{ ...DEFAULT_REPORT, ...patch }}
        scope={scope}
        kiosk={kiosk}
        editing={false}
      />
    </MemoryRouter>
  );

describe('ReportBody', () => {
  it('shows a table with a header and sorts when a header is clicked', () => {
    show({
      columns: [
        { field: 'name', header: 'Pod' },
        { field: 'restarts', header: '' },
      ],
    });
    expect(screen.getByRole('columnheader', { name: /Pod/ })).toBeTruthy();
    const names = () =>
      screen
        .getAllByRole('cell')
        .filter((_, i) => i % 2 === 0)
        .map(c => c.textContent);
    expect(names()).toEqual(['a', 'b', 'c']);
    fireEvent.click(screen.getByRole('button', { name: /Restarts/ }));
    fireEvent.click(screen.getByRole('button', { name: /Restarts/ }));
    expect(names()).toEqual(['c', 'b', 'a']);
    expect(screen.getByText(/Pod: 3 rows/)).toBeTruthy();
  });
  it('sorts on a click anywhere in the heading cell, not only on its text', () => {
    show({
      columns: [
        { field: 'name', header: 'Pod' },
        { field: 'restarts', header: '' },
      ],
    });
    const head = screen.getByRole('columnheader', { name: /Restarts/ });
    // The click lands on the cell itself, outside the text.
    fireEvent.click(head);
    expect(head.getAttribute('aria-sort')).toBe('ascending');
    fireEvent.click(head);
    expect(head.getAttribute('aria-sort')).toBe('descending');
    // The button fills the cell, so a click on it sorts once, not twice.
    const button = head.querySelector('[data-sort-cell]') as HTMLElement;
    expect(button).toBeTruthy();
    fireEvent.click(button);
    expect(head.getAttribute('aria-sort')).toBe('ascending');
  });
  it('renders only the visible rows of a long list', () => {
    const many = Array.from({ length: 5000 }, (_, i) => pod(`p-${i}`, 'x', 'Running', 0));
    show({}, many);
    expect(screen.getAllByRole('row').length).toBeLessThan(80);
    expect(screen.getByText(/5000 rows/)).toBeTruthy();
  });
  it('shows summary groups with a grand total and collapses a group', () => {
    show({
      reportType: 'summary',
      groupBy: ['namespace', 'status'],
      aggregates: [{ field: 'restarts', fn: 'sum' }],
      showRows: false,
    });
    expect(screen.getByText('prod')).toBeTruthy();
    expect(screen.getByText('Grand total')).toBeTruthy();
    expect(screen.getAllByText('Pending')).toHaveLength(1);
    fireEvent.click(screen.getByText('prod'));
    expect(screen.queryByText('Pending')).toBeNull();
    fireEvent.click(screen.getByText('prod'));
    expect(screen.getByText('Pending')).toBeTruthy();
  });
  it('draws one chart bar for every group', () => {
    const many = Array.from({ length: 30 }, (_, i) => pod(`p-${i}`, `ns-${i}`, 'Running', 0));
    const { container } = show(
      { reportType: 'summary', groupBy: ['namespace'], chart: 'bar' },
      many
    );
    expect(container.querySelectorAll('svg[role="img"] g > path')).toHaveLength(30);
    expect(container.textContent?.toLowerCase()).not.toContain('other');
  });
  it('draws every donut slice', () => {
    const many = Array.from({ length: 12 }, (_, i) => pod(`p-${i}`, `ns-${i}`, 'Running', 0));
    const { container } = show(
      { reportType: 'summary', groupBy: ['namespace'], chart: 'donut' },
      many
    );
    expect(container.querySelectorAll('svg[role="img"] path')).toHaveLength(12);
    expect(container.querySelectorAll('ul[aria-label="Legend"] li')).toHaveLength(12);
  });
  it('renders a matrix with totals', () => {
    show({ reportType: 'matrix', matrixRow: 'namespace', matrixCol: 'status' });
    expect(screen.getByRole('columnheader', { name: 'Pending' })).toBeTruthy();
    expect(screen.getByText('Total', { selector: '[role="cell"]' })).toBeTruthy();
  });
  it('keeps the first column of a matrix in view, and not of a tabular report', () => {
    const { container, unmount } = show({
      reportType: 'matrix',
      matrixRow: 'namespace',
      matrixCol: 'status',
    });
    const firstOf = (c: HTMLElement) => c.querySelector('[role="columnheader"]') as HTMLElement;
    expect(getComputedStyle(firstOf(container)).position).toBe('sticky');
    const firstCell = container.querySelector(
      '[role="row"][aria-rowindex="2"] [role="cell"]'
    ) as HTMLElement;
    expect(getComputedStyle(firstCell).position).toBe('sticky');
    unmount();
    const tabular = show({});
    expect(getComputedStyle(firstOf(tabular.container)).position).not.toBe('sticky');
  });
  it('hides the export button in the kiosk', () => {
    show({}, OBJECTS, true);
    expect(screen.queryByRole('button', { name: /CSV/ })).toBeNull();
  });
  it('warns about a bad filter logic string', () => {
    show({ filters: [{ field: 'name', op: 'eq', value: 'a' }], logic: '1 AND 2' });
    expect(screen.getByText(/filter logic is not valid/i)).toBeTruthy();
  });
});
