import { beforeEach, describe, expect, it, vi } from 'vitest';

const { queryMetrics } = vi.hoisted(() => ({ queryMetrics: vi.fn() }));
vi.mock('../metrics', () => ({ queryMetrics }));

import { fetchNodeMetrics } from './queries';

beforeEach(() => {
  queryMetrics.mockReset();
  queryMetrics.mockResolvedValue([]);
});

describe('fetchNodeMetrics runner pool queries', () => {
  it('sends no runner pool query with the prefix blank', async () => {
    await fetchNodeMetrics('');
    await fetchNodeMetrics();
    const sent = queryMetrics.mock.calls.map(c => String(c[0]));
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.filter(q => q.includes('runner_job_info') || q.includes('kube_pod_labels'))).toEqual([]);
  });

  it('sends the two runner pool queries with a prefix', async () => {
    await fetchNodeMetrics('acme');
    const sent = queryMetrics.mock.calls.map(c => String(c[0]));
    expect(sent.filter(q => q.includes('acme_runner_job_info'))).toHaveLength(1);
    expect(sent.filter(q => q.includes('kube_pod_labels'))).toHaveLength(1);
  });
});
