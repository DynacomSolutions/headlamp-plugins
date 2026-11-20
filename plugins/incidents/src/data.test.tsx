import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('@kinvolk/headlamp-plugin/lib', () => ({
  ApiProxy: { request },
  ConfigStore: class {
    useConfig() {
      return () => ({});
    }
  },
}));

import { useDiagnoses } from './data';

const settings = { namespace: 'ns', serviceName: 'svc', servicePort: '80' };
const diag = (i: number) => ({
  id: `d${i}`,
  createdAt: new Date(1_700_000_000_000 + i * 1000).toISOString(),
  status: 'done',
  source: 'alert',
  alert: { name: `A${i}`, severity: 'warning' },
  result: {},
});

describe('useDiagnoses (the Incidents page)', () => {
  beforeEach(() => request.mockReset());
  afterEach(cleanup);

  it('reads every page, so the page lists the real total and not the first 100', async () => {
    const all = Array.from({ length: 450 }, (_, i) => diag(i));
    request.mockImplementation(async (url: string) => {
      const q = new URL(url, 'http://x').searchParams;
      const offset = Number(q.get('offset') ?? 0);
      return { total: all.length, diagnoses: all.slice(offset, offset + Number(q.get('limit'))) };
    });
    const { result } = renderHook(() => useDiagnoses(settings));
    await waitFor(() => expect(result.current.data).not.toBeNull());
    expect(result.current.data).toHaveLength(450);
    // Newest first.
    expect(result.current.data![0].id).toBe('d449');
    const urls = request.mock.calls.map(c => c[0] as string);
    expect(urls.every(u => !u.includes('limit=100'))).toBe(true);
    expect(urls).toHaveLength(3);
  });

  it('shows the rows of an agent that sends no total', async () => {
    request.mockResolvedValue({ diagnoses: [diag(1), diag(2)] });
    const { result } = renderHook(() => useDiagnoses(settings));
    await waitFor(() => expect(result.current.data).toHaveLength(2));
    expect(request).toHaveBeenCalledTimes(1);
  });
});
