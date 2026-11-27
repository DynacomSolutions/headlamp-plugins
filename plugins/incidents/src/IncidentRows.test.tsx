import { createTheme, ThemeProvider } from '@mui/material/styles';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@kinvolk/headlamp-plugin/lib', () => ({
  Router: { createRouteURL: (name: string, p?: { id?: string }) => `/${name}/${p?.id ?? ''}` },
  ApiProxy: { request: vi.fn() },
  ConfigStore: class {},
}));

import { IncidentHero } from './IncidentHero';
import {
  bySeverityFirst,
  groupByAlert,
  IncidentRows,
  NARROW_BELOW,
  statusMixText,
  UNNAMED_ALERT,
} from './IncidentRows';
import { DiagnosisSummary, summariseDiagnoses } from './model';

afterEach(cleanup);

const d = (
  id: string,
  severity: string,
  status: DiagnosisSummary['status'] = 'done'
): DiagnosisSummary => ({
  id,
  createdAt: '2026-11-21T10:00:00Z',
  status,
  source: 'alertmanager',
  alertName: `Alert${id}`,
  severity,
  likelyCause: 'A cause.',
  confidence: 'high',
  resolved: false,
});

const wrap = (node: React.ReactNode) =>
  render(
    <ThemeProvider theme={createTheme({ palette: { mode: 'dark' } })}>
      <MemoryRouter>{node}</MemoryRouter>
    </ThemeProvider>
  );

describe('incident rows', () => {
  const rows = [d('1', 'warning'), d('2', 'info'), d('3', 'critical'), d('4', 'critical')];
  it('puts critical rows first, then warning, then the rest, and keeps the order of equals', () => {
    expect(bySeverityFirst(rows).map(r => r.id)).toEqual(['3', '4', '1', '2']);
  });
  it('draws one band for each incident with a severity shape and a status word', () => {
    const { container } = wrap(<IncidentRows rows={rows} />);
    // Every group is closed at first, so open them all.
    container.querySelectorAll('[data-incident-group]').forEach(h => fireEvent.click(h));
    expect(container.querySelectorAll('[data-incident-row]')).toHaveLength(4);
    const marks = Array.from(
      container.querySelectorAll('[data-incident-row] svg[data-severity]')
    ).map(s => s.getAttribute('data-severity'));
    expect(marks).toEqual(['critical', 'critical', 'warning', 'other']);
    expect(container.textContent).toContain('Analysed');
  });
  it('shows Run again on a failed row only when a re-run is given', () => {
    const failed = [d('9', 'critical', 'failed')];
    const open = (r: ReturnType<typeof wrap>) =>
      r.container.querySelectorAll('[data-incident-group]').forEach(h => fireEvent.click(h));
    const plain = wrap(<IncidentRows rows={failed} />);
    open(plain);
    expect(plain.queryByText('Run again')).toBeNull();
    cleanup();
    const withRerun = wrap(<IncidentRows rows={failed} onRerun={async () => {}} />);
    open(withRerun);
    expect(withRerun.getByText('Run again')).toBeTruthy();
  });
});

describe('incident groups', () => {
  const many = [
    d('a1', 'warning'),
    d('b1', 'info'),
    d('c1', 'critical', 'failed'),
    d('c2', 'warning'),
    d('c3', 'critical'),
  ].map(r => ({ ...r, alertName: r.id.startsWith('c') ? 'KubeDeploymentDown' : `Alert-${r.id}` }));

  it('makes one group for each alert name, with its rows and a count', () => {
    const groups = groupByAlert(many);
    const down = groups.find(g => g.name === 'KubeDeploymentDown')!;
    expect(down.rows.map(r => r.id)).toEqual(['c1', 'c3', 'c2']);
    expect(groups).toHaveLength(3);
    expect(groups.flatMap(g => g.rows)).toHaveLength(many.length);
  });
  it('takes the worst severity of the rows as the severity of the group', () => {
    const groups = groupByAlert(many);
    expect(Object.fromEntries(groups.map(g => [g.name, g.worst]))).toEqual({
      KubeDeploymentDown: 'critical',
      'Alert-a1': 'warning',
      'Alert-b1': 'other',
    });
    // A group of warnings stays a warning, whatever its size.
    const warn = groupByAlert(
      [d('1', 'warning'), d('2', 'info')].map(r => ({ ...r, alertName: 'X' }))
    );
    expect(warn[0].worst).toBe('warning');
  });
  it('orders the groups by worst severity, then by size, then by name', () => {
    const rows2 = [
      d('1', 'info'),
      d('2', 'info'),
      d('3', 'warning'),
      d('4', 'critical'),
      d('5', 'warning'),
      d('6', 'warning'),
    ].map((r, i) => ({ ...r, alertName: ['Z', 'Z', 'W', 'C', 'V', 'V'][i] }));
    expect(groupByAlert(rows2).map(g => g.name)).toEqual(['C', 'V', 'W', 'Z']);
  });
  it('counts the status mix and writes it with the failed ones first', () => {
    const down = groupByAlert(many).find(g => g.name === 'KubeDeploymentDown')!;
    expect(down.byStatus).toEqual({ queued: 0, running: 0, done: 2, failed: 1, skipped: 0 });
    expect(statusMixText(down.byStatus)).toBe('1 failed, 2 analysed');
    expect(statusMixText({ ...down.byStatus, skipped: 3 })).toBe('1 failed, 3 not investigated, 2 analysed');
  });
  it('puts an alert with no name in a group of its own, never in a shared bucket', () => {
    const groups = groupByAlert([{ ...d('1', 'info'), alertName: '' }]);
    expect(groups.map(g => g.name)).toEqual([UNNAMED_ALERT]);
  });

  it('shows the groups and no incident rows at first', () => {
    const { container } = wrap(<IncidentRows rows={many} />);
    const headers = Array.from(container.querySelectorAll('[data-incident-group]'));
    expect(headers.map(h => h.getAttribute('data-incident-group'))).toEqual([
      'KubeDeploymentDown',
      'Alert-a1',
      'Alert-b1',
    ]);
    expect(headers.every(h => h.getAttribute('aria-expanded') === 'false')).toBe(true);
    expect(container.querySelectorAll('[data-incident-row]')).toHaveLength(0);
  });
  it('shows the name, the count, the worst severity and the status mix in a header', () => {
    const { container } = wrap(<IncidentRows rows={many} />);
    const h = container.querySelector('[data-incident-group="KubeDeploymentDown"]') as HTMLElement;
    expect(h.textContent).toContain('KubeDeploymentDown');
    expect(h.querySelector('[data-group-count]')?.textContent).toBe('3');
    expect(h.querySelector('[data-group-mix]')?.textContent).toBe('1 failed, 2 analysed');
    expect(h.querySelector('svg[data-severity]')?.getAttribute('data-severity')).toBe('critical');
    expect(h.querySelector('svg[data-severity]')?.getAttribute('aria-label')).toBe('Critical');
  });
  it('opens and closes a group with a click or the keyboard, and the other groups stay as they are', () => {
    const { container } = wrap(<IncidentRows rows={many} />);
    const h = () => container.querySelector('[data-incident-group="KubeDeploymentDown"]')!;
    fireEvent.click(h());
    expect(h().getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelectorAll('[data-incident-row]')).toHaveLength(3);
    expect(
      container.querySelector('[data-incident-group="Alert-a1"]')?.getAttribute('aria-expanded')
    ).toBe('false');
    fireEvent.keyDown(h(), { key: 'Enter' });
    expect(container.querySelectorAll('[data-incident-row]')).toHaveLength(0);
    fireEvent.keyDown(h(), { key: ' ' });
    expect(container.querySelectorAll('[data-incident-row]')).toHaveLength(3);
  });
  it('keeps a group open when the rows refresh', () => {
    const r = wrap(<IncidentRows rows={many} />);
    fireEvent.click(r.container.querySelector('[data-incident-group="Alert-a1"]')!);
    r.rerender(
      <ThemeProvider theme={createTheme({ palette: { mode: 'dark' } })}>
        <MemoryRouter>
          <IncidentRows rows={[...many]} />
        </MemoryRouter>
      </ThemeProvider>
    );
    expect(r.container.querySelectorAll('[data-incident-row]')).toHaveLength(1);
  });
  it('keeps the cause on one line with the full text on hover', () => {
    const long = 'A very long cause. '.repeat(20);
    const { container } = wrap(
      <IncidentRows rows={[{ ...d('1', 'critical'), likelyCause: long }]} />
    );
    fireEvent.click(container.querySelector('[data-incident-group]')!);
    const text = container.querySelector('[data-incident-row] [title]') as HTMLElement;
    expect(text.getAttribute('title')).toBe(long);
    const header = container.querySelector('[data-incident-group] [title]') as HTMLElement;
    expect(header.getAttribute('title')).toBe('Alert1');
  });
  it('shows no "other" or "more" text, because every group has its own row', () => {
    const { container } = wrap(<IncidentRows rows={many} />);
    expect(container.textContent).not.toMatch(/\bmore\b|\bother\b/i);
  });
});

describe('incident rows by widget width', () => {
  const sizes = new Map<Element, number>();
  const callbacks: Array<() => void> = [];
  const realRect = Element.prototype.getBoundingClientRect;
  beforeEach(() => {
    sizes.clear();
    callbacks.length = 0;
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: () => void) {
          callbacks.push(cb);
        }
        observe() {}
        disconnect() {}
      }
    );
    Element.prototype.getBoundingClientRect = function () {
      const w = sizes.get(this) ?? 1000;
      return { width: w, height: 10, top: 0, left: 0, right: w, bottom: 10, x: 0, y: 0 } as DOMRect;
    };
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    Element.prototype.getBoundingClientRect = realRect;
  });
  const open = (c: HTMLElement) =>
    c.querySelectorAll('[data-incident-group]').forEach(h => fireEvent.click(h));

  it('shows the status word of every row in a wide widget', () => {
    const { container } = wrap(<IncidentRows rows={[d('1', 'critical')]} />);
    open(container);
    expect(container.querySelector('[data-incident-rows]')?.hasAttribute('data-narrow')).toBe(
      false
    );
    expect(container.querySelector('[data-status="done"]')).toBeTruthy();
  });
  it('hides the status word of an analysed row in a narrow widget, and keeps the other states', () => {
    const rowsNarrow = [d('1', 'critical'), d('2', 'critical', 'failed')].map(r => ({
      ...r,
      alertName: 'Same',
    }));
    const { container } = wrap(<IncidentRows rows={rowsNarrow} />);
    const root = container.querySelector('[data-incident-rows]') as HTMLElement;
    sizes.set(root, 300);
    act(() => callbacks.forEach(cb => cb()));
    open(container);
    expect(root.hasAttribute('data-narrow')).toBe(true);
    expect(container.querySelectorAll('[data-incident-row]')).toHaveLength(2);
    expect(container.querySelector('[data-status="done"]')).toBeNull();
    expect(container.querySelector('[data-status="failed"]')).toBeTruthy();
    // The time and the header mix stay.
    expect(container.querySelector('[data-group-mix]')?.textContent).toBe('1 failed, 1 analysed');
  });
  it('measures the widget, not the window', () => {
    const { container } = wrap(<IncidentRows rows={[d('1', 'critical')]} />);
    const root = container.querySelector('[data-incident-rows]') as HTMLElement;
    Object.defineProperty(window, 'innerWidth', { value: 300, configurable: true });
    act(() => callbacks.forEach(cb => cb()));
    expect(root.hasAttribute('data-narrow')).toBe(false);
    sizes.set(root, NARROW_BELOW - 1);
    act(() => callbacks.forEach(cb => cb()));
    expect(root.hasAttribute('data-narrow')).toBe(true);
    sizes.set(root, NARROW_BELOW);
    act(() => callbacks.forEach(cb => cb()));
    expect(root.hasAttribute('data-narrow')).toBe(false);
  });
});

describe('incident hero', () => {
  it('shows the critical count in large type and the failed analyses', () => {
    const counts = summariseDiagnoses([
      d('1', 'critical'),
      d('2', 'critical'),
      d('3', 'warning', 'failed'),
    ]);
    const { container } = wrap(<IncidentHero counts={counts} />);
    expect(container.querySelector('[data-count="critical"]')?.textContent).toBe('2');
    expect(container.querySelector('[data-count="warning"]')?.textContent).toBe('1');
    expect(container.querySelector('[data-count="failed analyses"]')?.textContent).toBe('1');
    expect(container.textContent).toContain('3 incidents');
  });
});
