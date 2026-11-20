import { createTheme, ThemeProvider } from '@mui/material/styles';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
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
import {
  BreakdownConfig,
  breakdownWidget,
  DEFAULT_BREAKDOWN,
  formatShare,
  sliceAngles,
} from './BreakdownWidget';
import { DEFAULT_GAUGE, gaugeFraction, gaugeWidget } from './GaugeWidget';
import { PROMQL_WIDGETS } from './index';
import { parseMatrix } from './mapping';
import { DEFAULT_STAT, reduceSeries, statValue, statWidget } from './StatWidget';
import { DEFAULT_TABLE, sortRows, tableWidget } from './TableWidget';
import { barPath } from './TimeSeriesView';
import { DEFAULT_TIMESERIES, timeSeriesWidget } from './TimeSeriesWidget';

function reply(resultType: string, result: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ status: 'success', data: { resultType, result } }),
  };
}

const matrix = (n = 5) => [
  {
    metric: { namespace: 'a' },
    values: Array.from({ length: n }, (_, i) => [1_700_000_000 + i * 60, String(i + 1)]),
  },
  {
    metric: { namespace: 'b' },
    values: Array.from({ length: n }, (_, i) => [1_700_000_000 + i * 60, String(10 - i)]),
  },
];

function props<C>(config: C, over: Partial<WidgetProps<C>> = {}): WidgetProps<C> {
  return {
    instanceId: 'w1',
    config,
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

describe('registration', () => {
  it('has five widgets with unique types, a settings component and sensible sizes', () => {
    expect(PROMQL_WIDGETS.map(w => w.type)).toEqual([
      'promql.timeseries',
      'promql.stat',
      'promql.gauge',
      'promql.table',
      'promql.breakdown',
    ]);
    for (const w of PROMQL_WIDGETS) {
      expect(w.SettingsComponent).toBeTruthy();
      expect(w.minSize!.w).toBeLessThanOrEqual(w.defaultSize.w);
      expect(w.category).toBe('Monitoring');
    }
  });
});

describe('time series widget', () => {
  it('fetches a range query with the filters and a capped number of points, then draws every series', async () => {
    request.mockResolvedValue(reply('matrix', matrix()));
    const reportRefreshed = vi.fn();
    const filters = { ...defaultFilters(), namespaces: ['a', 'b'], range: '6h' as const };
    const C = timeSeriesWidget.Component;
    const { container } = render(
      <C {...props({ ...DEFAULT_TIMESERIES, kind: 'line' }, { filters, reportRefreshed })} />
    );
    await waitFor(() =>
      expect(container.querySelectorAll('svg path[stroke]').length).toBeGreaterThanOrEqual(2)
    );
    expect(request).toHaveBeenCalledTimes(1);
    const url = decodeURIComponent(request.mock.calls[0][0] as string);
    expect(url).toContain('/proxy/api/v1/query_range?');
    expect(url).toContain('namespace=~"a|b"');
    const q = new URL(`http://x${request.mock.calls[0][0]}`).searchParams;
    expect(
      (Number(q.get('end')) - Number(q.get('start'))) / Number(q.get('step'))
    ).toBeLessThanOrEqual(300);
    expect(reportRefreshed).toHaveBeenCalled();
    // The legend names both series.
    // The legend shows the value that differs, and the title keeps the full label set.
    expect(container.textContent).not.toContain('namespace="a"');
    const entry = container.querySelector('button[title*="namespace=\\"a\\""]') as HTMLElement;
    expect(entry.textContent).toBe('a');
  });

  it('shows one tooltip with every series at the pointer', async () => {
    request.mockResolvedValue(reply('matrix', matrix()));
    const C = timeSeriesWidget.Component;
    const { container } = render(
      <C {...props({ ...DEFAULT_TIMESERIES, unit: 'plain', queries: '# {{namespace}}\nup' })} />
    );
    const svg = await waitFor(() => {
      const el = container.querySelector('svg[role="img"][tabindex="0"]');
      expect(el).toBeTruthy();
      return el as SVGSVGElement;
    });
    fireEvent.keyDown(svg, { key: 'ArrowRight' });
    const tip = container.querySelector('[data-chart-tooltip]') as HTMLElement;
    expect(tip).toBeTruthy();
    expect(tip.textContent).toContain('a');
    expect(tip.textContent).toContain('b');
    fireEvent.keyDown(svg, { key: 'Escape' });
    expect(container.querySelector('[data-chart-tooltip]')).toBeNull();
  });

  it('does not fetch again on a rerender with the same inputs, and fetches on a refresh signal', async () => {
    request.mockResolvedValue(reply('matrix', matrix()));
    const C = timeSeriesWidget.Component;
    const p = props(DEFAULT_TIMESERIES);
    const { rerender } = render(<C {...p} />);
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    rerender(<C {...p} />);
    rerender(<C {...p} editing />);
    await act(async () => {});
    expect(request).toHaveBeenCalledTimes(1);
    rerender(<C {...p} refreshSignal={1} />);
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  });

  it('does not fetch again when the widget is resized', async () => {
    request.mockResolvedValue(reply('matrix', matrix()));
    const C = timeSeriesWidget.Component;
    let observer: (() => void) | undefined;
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: (e: unknown[]) => void) {
          observer = () => cb([{ contentRect: { width: 900, height: 400 } }]);
        }
        observe() {}
        disconnect() {}
      }
    );
    render(<C {...props(DEFAULT_TIMESERIES)} />);
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    act(() => observer?.());
    await act(async () => {});
    expect(request).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it('aborts the request in flight when the refresh signal changes', async () => {
    const signals: AbortSignal[] = [];
    request.mockImplementation((_url: string, params: { signal: AbortSignal }) => {
      signals.push(params.signal);
      return new Promise(() => {});
    });
    const C = timeSeriesWidget.Component;
    const p = props(DEFAULT_TIMESERIES);
    const { rerender, unmount } = render(<C {...p} />);
    await waitFor(() => expect(signals).toHaveLength(1));
    rerender(<C {...p} refreshSignal={1} />);
    await waitFor(() => expect(signals).toHaveLength(2));
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);
    unmount();
    expect(signals[1].aborted).toBe(true);
  });

  it('shows a readable error', async () => {
    request.mockResolvedValue({
      ok: false,
      status: 422,
      json: async () => ({ status: 'error', error: 'bad query' }),
    });
    const C = timeSeriesWidget.Component;
    const { container } = render(<C {...props(DEFAULT_TIMESERIES)} />);
    await waitFor(() =>
      expect(container.querySelector('[role="alert"]')?.textContent).toContain('bad query')
    );
  });

  it('asks for a query when there is none, without a request', async () => {
    const C = timeSeriesWidget.Component;
    const { container } = render(<C {...props({ ...DEFAULT_TIMESERIES, queries: '  ' })} />);
    expect(container.textContent).toContain('Set a query');
    expect(request).not.toHaveBeenCalled();
  });

  it('draws bars and stacked areas', async () => {
    request.mockResolvedValue(reply('matrix', matrix()));
    const C = timeSeriesWidget.Component;
    const bars = render(<C {...props({ ...DEFAULT_TIMESERIES, kind: 'bar' })} />);
    // Two series and five times: bars stack, so there are two segments for each time.
    await waitFor(() =>
      expect(bars.container.querySelectorAll('svg path[fill^="#"][stroke]').length).toBe(10)
    );
    cleanup();
    const area = render(<C {...props({ ...DEFAULT_TIMESERIES, kind: 'stacked' })} />);
    await waitFor(() =>
      expect(area.container.querySelectorAll('svg path[fill-opacity]').length).toBe(2)
    );
  });

  it('builds a rounded bar that stands on the baseline', () => {
    const d = barPath(10, 100, 8, 20, 4);
    expect(d.startsWith('M10,100V24')).toBe(true);
    expect(barPath(10, 100, 8, 100, 4)).toContain('V100');
  });
});

describe('stat tile', () => {
  it('shows the value from an instant query, with the status of the threshold', async () => {
    request.mockResolvedValue(reply('vector', [{ metric: {}, value: [1, '95'] }]));
    const C = statWidget.Component;
    const { container } = render(
      <C
        {...props({
          ...DEFAULT_STAT,
          sparkline: false,
          unit: 'percent',
          thresholds: '70:warning, 90:critical',
        })}
      />
    );
    await waitFor(() =>
      expect(container.querySelector('[data-stat-value]')?.textContent).toBe('95%')
    );
    expect(container.querySelector('[data-level="critical"]')?.textContent).toBe('Critical');
    expect(decodeURIComponent(request.mock.calls[0][0] as string)).toContain('/api/v1/query?');
  });

  it('draws a sparkline from a range query and takes the last value', async () => {
    request.mockResolvedValue(
      reply('matrix', [
        {
          metric: {},
          values: [
            [1, '1'],
            [2, '2'],
            [3, '7'],
          ],
        },
      ])
    );
    const C = statWidget.Component;
    const { container } = render(<C {...props({ ...DEFAULT_STAT, sparkline: true })} />);
    await waitFor(() =>
      expect(container.querySelector('[data-stat-value]')?.textContent).toBe('7')
    );
    expect(container.querySelector('svg path[stroke]')).toBeTruthy();
    expect(container.querySelector('[data-level]')).toBeNull();
  });

  it('reduces several series', () => {
    const results = [
      {
        resultType: 'vector',
        result: [
          { metric: { a: '1' }, value: [1, '2'] },
          { metric: { a: '2' }, value: [1, '3'] },
        ],
      },
    ];
    expect(statValue(results, { sparkline: false, reduce: 'sum' })?.value).toBe(5);
    expect(statValue(results, { sparkline: false, reduce: 'max' })?.value).toBe(3);
    const s = parseMatrix(matrix(3));
    expect(reduceSeries(s, 'sum').points.map(p => p.v)).toEqual([11, 11, 11]);
    expect(
      statValue([{ resultType: 'matrix', result: [] }], { sparkline: true, reduce: 'first' })
    ).toEqual({ value: null, spark: [] });
  });
});

describe('gauge', () => {
  it('fills a share of the scale, clamped', () => {
    expect(gaugeFraction(50, 0, 100)).toBe(0.5);
    expect(gaugeFraction(150, 0, 100)).toBe(1);
    expect(gaugeFraction(-5, 0, 100)).toBe(0);
    expect(gaugeFraction(5, 10, 10)).toBe(0);
  });
  it('shows the value, the scale and the level', async () => {
    request.mockResolvedValue(reply('vector', [{ metric: {}, value: [1, '75'] }]));
    const C = gaugeWidget.Component;
    const { container } = render(<C {...props(DEFAULT_GAUGE)} />);
    await waitFor(() => expect(container.querySelector('[data-gauge-value]')).toBeTruthy());
    expect(container.querySelector('svg')?.getAttribute('aria-label')).toContain('75%');
    expect(container.querySelector('[data-level="warning"]')).toBeTruthy();
  });
});

describe('query table', () => {
  const samples = [
    { metric: { namespace: 'web', pod: 'p1' }, value: [1, '30'] },
    { metric: { namespace: 'web', pod: 'p2' }, value: [1, '100'] },
    { metric: { namespace: 'api', pod: 'p3' }, value: [1, '2'] },
  ];
  it('shows a row per series, sorted by the first value column, and sorts on a header click', async () => {
    request.mockResolvedValue(reply('vector', samples));
    const C = tableWidget.Component;
    const { container, getByText } = render(
      <C {...props({ ...DEFAULT_TABLE, queries: '# Memory | bytes\nup', labels: 'pod' })} />
    );
    await waitFor(() => expect(container.querySelectorAll('tbody tr')).toHaveLength(3));
    const firstCells = () =>
      [...container.querySelectorAll('tbody tr')].map(r => r.querySelector('td')?.textContent);
    expect(firstCells()).toEqual(['p2', 'p1', 'p3']);
    expect(container.querySelector('tbody tr td:last-child')?.textContent).toBe('100 B');
    fireEvent.click(getByText('Memory'));
    expect(firstCells()).toEqual(['p3', 'p1', 'p2']);
    fireEvent.click(getByText('pod'));
    expect(firstCells()).toEqual(['p1', 'p2', 'p3']);
  });
  it('sorts empty values last in both directions', () => {
    const rows = [
      { key: 'a', cells: ['a'], values: [null] },
      { key: 'b', cells: ['b'], values: [2] },
      { key: 'c', cells: ['c'], values: [9] },
    ];
    expect(sortRows(rows, 1, { column: 1, dir: 'asc' }).map(r => r.key)).toEqual(['b', 'c', 'a']);
    expect(sortRows(rows, 1, { column: 1, dir: 'desc' }).map(r => r.key)).toEqual(['c', 'b', 'a']);
  });
});

describe('breakdown', () => {
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      metric: { namespace: `ns${i}` },
      value: [1, String(i + 1)],
    }));
  const cfg = (over: Partial<BreakdownConfig> = {}): BreakdownConfig => ({
    ...DEFAULT_BREAKDOWN,
    unit: 'plain',
    ...over,
  });

  it('shows every group as its own slice, with no Other and no top-N', async () => {
    request.mockResolvedValue(reply('vector', many(30)));
    const C = breakdownWidget.Component;
    const { container } = render(<C {...props(cfg())} />);
    await waitFor(() => expect(container.querySelectorAll('[data-slice]')).toHaveLength(30));
    expect(container.querySelectorAll('[role="listitem"]')).toHaveLength(30);
    expect(container.textContent).not.toContain('Other');
  });
  it('shows every group as a bar in bar view', async () => {
    request.mockResolvedValue(reply('vector', many(30)));
    const C = breakdownWidget.Component;
    const { container } = render(<C {...props(cfg({ view: 'bar' }))} />);
    await waitFor(() => expect(container.querySelectorAll('[data-bar]')).toHaveLength(30));
    const widths = [...container.querySelectorAll('[data-bar]')].map(
      b => (b as HTMLElement).style.width || getComputedStyle(b).width
    );
    expect(widths.length).toBe(30);
  });
  it('draws slices at their real size', () => {
    const slices = sliceAngles([
      { key: 'a', name: 'a', value: 75 },
      { key: 'b', name: 'b', value: 25 },
      { key: 'c', name: 'c', value: 0 },
    ]);
    expect(slices).toHaveLength(2);
    expect(slices[0].to - slices[0].from).toBeCloseTo(Math.PI * 1.5);
    expect(slices[1].to).toBeCloseTo(Math.PI * 2);
    expect(sliceAngles([])).toEqual([]);
  });
  it('formats shares', () => {
    expect(formatShare(25, 100)).toBe('25%');
    expect(formatShare(1, 3000)).toBe('<0.1%');
    expect(formatShare(5, 0)).toBe('0%');
    expect(formatShare(7, 100)).toBe('7.0%');
  });
});

describe('kiosk', () => {
  const colourIn = async (mode: 'light' | 'dark') => {
    request.mockResolvedValue(reply('vector', [{ metric: {}, value: [1, '5'] }]));
    const C = statWidget.Component;
    const { container } = render(
      <ThemeProvider theme={createTheme({ palette: { mode } })}>
        <C {...props({ ...DEFAULT_STAT, sparkline: false }, { kiosk: true })} />
      </ThemeProvider>
    );
    await waitFor(() => expect(container.querySelector('[data-stat-value]')).toBeTruthy());
    return getComputedStyle(container.querySelector('[data-stat-value]') as HTMLElement).color;
  };
  it('uses black based ink on the black kiosk of a dark theme', async () => {
    expect(await colourIn('dark')).toBe('rgb(240, 239, 236)');
  });
  it('keeps the normal ink in a light theme, where the kiosk stays light', async () => {
    expect(await colourIn('light')).not.toBe('rgb(240, 239, 236)');
  });
});
