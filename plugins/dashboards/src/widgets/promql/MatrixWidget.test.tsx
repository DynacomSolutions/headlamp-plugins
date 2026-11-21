import { createTheme, ThemeProvider } from '@mui/material/styles';
import { cleanup, render, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const request = vi.fn();
vi.mock('@iconify/react', () => ({ Icon: (p: { icon: string }) => <i data-icon={p.icon} /> }));
vi.mock('@kinvolk/headlamp-plugin/lib', () => ({
  ApiProxy: { request: (...a: unknown[]) => request(...a) },
  ConfigStore: class {
    useConfig() {
      return () => undefined;
    }
  },
}));

import type { WidgetProps } from '../../contract';
import { defaultFilters } from '../../spec/model';
import { buildMatrix, cellStatus, MatrixOptions, summaryText } from './matrix';
import { cellTitle, DEFAULT_MATRIX, matrixWidget } from './MatrixWidget';

const opts: MatrixOptions = {
  rowLabel: 'source',
  columnLabel: 'target',
  sameSet: true,
  warnAbove: 0,
  critAbove: 0.02,
  unit: 'ratio',
};

const sample = (source: string, target: string, value: number | null) => ({
  key: `${source}-${target}`,
  labels: { source, target },
  name: '',
  value,
});

describe('matrix model', () => {
  it('marks above 0 as a warning and above the limit as critical', () => {
    expect(cellStatus(0, 0, 0.02)).toBe('ok');
    expect(cellStatus(0.0001, 0, 0.02)).toBe('warn');
    expect(cellStatus(0.02, 0, 0.02)).toBe('warn');
    expect(cellStatus(0.020000000001, 0, 0.02)).toBe('warn');
    expect(cellStatus(0.0201, 0, 0.02)).toBe('crit');
    expect(cellStatus(null, 0, 0.02)).toBe('unknown');
  });

  it('keeps a pair with no sample as no data, never as zero', () => {
    const m = buildMatrix(
      [sample('a', 'b', 0), sample('b', 'a', 0.05), sample('a', 'c', null)],
      [],
      [],
      opts
    );
    expect(m.rows).toEqual(['a', 'b', 'c']);
    expect(m.cols).toEqual(['a', 'b', 'c']);
    // 3 members give 6 pairs. The diagonal is not a pair.
    expect(m.summary.pairs).toBe(6);
    expect(m.cell('a', 'a')).toBeUndefined();
    expect(m.cell('a', 'b')?.status).toBe('ok');
    expect(m.cell('c', 'a')).toMatchObject({ value: null, status: 'unknown' });
    expect(m.cell('a', 'c')).toMatchObject({ value: null, status: 'unknown' });
    expect(m.summary).toMatchObject({ above: 1, noData: 4, warn: 0 });
    expect(m.summary.worst).toEqual({ row: 'b', col: 'a', value: 0.05 });
    expect(m.status).toBe('crit');
  });

  it('adds a member that only appears as a target', () => {
    const m = buildMatrix([sample('a', 'z', 0)], [], [], opts);
    expect(m.rows).toEqual(['a', 'z']);
    expect(m.cell('z', 'a')?.status).toBe('unknown');
  });

  it('reads relayed paths and the round trip time', () => {
    const m = buildMatrix(
      [sample('a', 'b', 0), sample('b', 'a', 0)],
      [sample('a', 'b', 0), sample('b', 'a', 1)],
      [sample('a', 'b', 0.0123)],
      opts
    );
    expect(m.cell('a', 'b')).toMatchObject({ direct: false, rtt: 0.0123 });
    expect(m.cell('b', 'a')).toMatchObject({ direct: true, rtt: null });
    expect(m.summary.relayed).toBe(1);
    expect(cellTitle(m.cell('a', 'b')!, 'ratio')).toBe(
      'a to b, 0%, round trip 12.3 ms, relayed path'
    );
  });

  it('builds the fixed summary line', () => {
    const m = buildMatrix([sample('a', 'b', 0.035), sample('b', 'a', 0.01)], [], [], opts);
    expect(summaryText(m.summary, opts)).toBe('2 pairs, 1 above 2%, 0 no data, worst a to b 3.5%');
    const quiet = buildMatrix([sample('a', 'b', 0), sample('b', 'a', 0)], [], [], opts);
    expect(summaryText(quiet.summary, opts)).toBe('2 pairs, 0 above 2%, 0 no data');
    expect(quiet.status).toBe('ok');
  });

  it('uses separate rows and columns when the set is not shared', () => {
    const m = buildMatrix([sample('a', 'x'.toString(), 1)], [], [], { ...opts, sameSet: false });
    expect(m.rows).toEqual(['a']);
    expect(m.cols).toEqual(['x']);
    expect(m.summary.pairs).toBe(1);
  });
});

function reply(result: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ status: 'success', data: { resultType: 'vector', result } }),
  };
}
const vec = (source: string, target: string, v: string) => ({
  metric: { source, target },
  value: [1, v],
});

function props(over: Partial<WidgetProps<typeof DEFAULT_MATRIX>> = {}) {
  return {
    instanceId: 'w1',
    config: DEFAULT_MATRIX,
    filters: defaultFilters(),
    refreshSignal: 0,
    reportRefreshed: vi.fn(),
    editing: false,
    kiosk: false,
    ...over,
  };
}

beforeEach(() => {
  request.mockReset();
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 600 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, value: 300 });
});
afterEach(cleanup);

const answer = (url: string) => {
  const q = decodeURIComponent(url);
  if (q.includes('loss_ratio'))
    return reply([
      vec('a', 'b', '0'),
      vec('b', 'a', '0.013333'),
      vec('a', 'c', '0.05'),
      vec('c', 'a', '0'),
    ]);
  if (q.includes('ping_direct')) return reply([vec('a', 'b', '0'), vec('b', 'a', '1')]);
  return reply([vec('a', 'b', '0.0042')]);
};

describe('matrix widget', () => {
  const C = matrixWidget.Component;
  const renderIt = (kiosk = false) =>
    render(
      <ThemeProvider theme={createTheme({ palette: { mode: 'dark' } })}>
        <C {...props({ kiosk })} />
      </ThemeProvider>
    );

  it('draws every pair, marks the pairs above the limit and shows no data as a dash', async () => {
    request.mockImplementation(async (url: string) => answer(url));
    const { container } = renderIt();
    await waitFor(() => expect(container.querySelectorAll('[data-matrix-cell]').length).toBe(6));
    const cell = (r: string, c: string) =>
      container.querySelector(`[data-matrix-cell][data-row="${r}"][data-col="${c}"]`)!;
    expect(cell('a', 'b').textContent).toContain('0%');
    expect(cell('a', 'b').getAttribute('data-status')).toBe('ok');
    expect(cell('b', 'a').textContent).toContain('1.33%');
    expect(cell('b', 'a').getAttribute('data-status')).toBe('warn');
    expect(cell('a', 'c').textContent).toContain('5%');
    expect(cell('a', 'c').getAttribute('data-status')).toBe('crit');
    // A pair with no sample is a dash, never 0.
    expect(cell('c', 'b').getAttribute('data-status')).toBe('unknown');
    expect(cell('c', 'b').textContent).toBe('-');
    expect(cell('c', 'b').textContent).not.toContain('0');
    // The warning and critical cells have a shape, so colour is not the only cue.
    expect(cell('a', 'c').querySelector('svg[data-status="crit"]')).toBeTruthy();
    expect(cell('b', 'a').querySelector('svg[data-status="warn"]')).toBeTruthy();
    // A relayed path has a mark, a direct one has none.
    expect(cell('a', 'b').querySelector('[data-matrix-relayed]')).toBeTruthy();
    expect(cell('b', 'a').querySelector('[data-matrix-relayed]')).toBeNull();
    expect(cell('a', 'b').getAttribute('title')).toContain('round trip 4.2 ms');
    expect(cell('a', 'b').getAttribute('title')).toContain('relayed path');
    expect(container.querySelectorAll('[data-matrix-diagonal]')).toHaveLength(3);
  });

  it('shows the fixed summary and the key, with no "+N more" and no "Other" group', async () => {
    request.mockImplementation(async (url: string) => answer(url));
    const { container } = renderIt();
    await waitFor(() => expect(container.querySelector('[data-matrix-summary]')).toBeTruthy());
    expect(container.querySelector('[data-matrix-summary]')?.textContent).toBe(
      '6 pairs, 1 above 2%, 2 no data, worst a to c 5%'
    );
    expect(container.querySelector('[data-matrix-key]')?.textContent).toContain('R relayed path');
    expect(container.querySelector('[data-matrix-key]')?.textContent).toContain('- no data');
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/\+\s?\d+ more|\bmore\b/i);
    expect(text).not.toMatch(/\bOther\b/);
  });

  it('runs the three queries and ignores a blank optional one', async () => {
    request.mockImplementation(async (url: string) => answer(url));
    render(<C {...props({ config: { ...DEFAULT_MATRIX, rttQuery: '' } })} />);
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    const urls = request.mock.calls.map(c => decodeURIComponent(c[0] as string));
    expect(urls.some(u => u.includes('avg_over_time(ping_loss_ratio[5m])'))).toBe(true);
  });

  it('says so when the value query returns nothing', async () => {
    request.mockResolvedValue(reply([]));
    const { container } = render(<C {...props()} />);
    await waitFor(() => expect(container.textContent).toContain('The query returned no data.'));
  });

  it('shows an error when the first fetch fails', async () => {
    request.mockRejectedValue(new Error('boom'));
    const { container } = render(<C {...props()} />);
    await waitFor(() => expect(container.textContent).toContain('boom'));
  });
});
