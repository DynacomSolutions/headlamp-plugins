import { describe, expect, it } from 'vitest';
import { queryUrl } from './metrics';

describe('queryUrl', () => {
  it('goes through the Service proxy of the metrics Service', () => {
    const url = queryUrl({ namespace: 'monitoring', service: 'victoria-metrics', port: '8428' }, '{__name__=~".+_workflow_overdue"}');
    expect(url.startsWith('/api/v1/namespaces/monitoring/services/victoria-metrics:8428/proxy/api/v1/query?query=')).toBe(true);
    expect(decodeURIComponent(url.split('query=')[1])).toBe('{__name__=~".+_workflow_overdue"}');
  });
});
