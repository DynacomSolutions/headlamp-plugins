import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const streamResults = vi.fn();
const request = vi.fn();
vi.mock('@iconify/react', () => ({ Icon: (p: { icon: string }) => <i data-icon={p.icon} /> }));
vi.mock('@kinvolk/headlamp-plugin/lib', () => ({
  ApiProxy: {
    request: (...a: unknown[]) => request(...a),
    streamResults: (...a: unknown[]) => streamResults(...a),
  },
  K8s: { ResourceClasses: {} },
  Router: { createRouteURL: () => '/x' },
}));

import { defaultFilters } from '../../spec/model';
import { DEFAULT_REPORT } from './config';
import { fetchKinds, listPath, sortKinds } from './discovery';
import { k8sReportWidget } from './K8sReportWidget';
import { ReportSettings } from './ReportSettings';

const Widget = k8sReportWidget.Component;
const pod = (name: string, ns: string) => ({ kind: 'Pod', metadata: { name, namespace: ns, uid: name }, status: { phase: 'Running' } });

beforeEach(() => {
  streamResults.mockReset();
  request.mockReset();
  streamResults.mockImplementation(async (url: string, cb: (items: unknown[]) => void) => {
    cb(url.includes('/namespaces/dev/') ? [pod('d1', 'dev')] : url.includes('/namespaces/prod/') ? [pod('a', 'prod')] : [pod('a', 'prod'), pod('d1', 'dev')]);
    return () => undefined;
  });
});
afterEach(cleanup);

const renderWidget = (filters = defaultFilters(), refreshSignal = 0, reportRefreshed = vi.fn()) =>
  render(
    <MemoryRouter>
      <Widget instanceId="w" config={DEFAULT_REPORT} filters={filters} refreshSignal={refreshSignal} reportRefreshed={reportRefreshed} editing={false} kiosk={false} />
    </MemoryRouter>
  );

describe('Kubernetes report widget', () => {
  it('lists the kind, shows rows and reports the refresh time', async () => {
    const reportRefreshed = vi.fn();
    renderWidget(defaultFilters(), 0, reportRefreshed);
    await waitFor(() => expect(screen.getByText('a')).toBeTruthy());
    expect(streamResults.mock.calls[0][0]).toBe('/api/v1/pods');
    expect(reportRefreshed).toHaveBeenCalled();
  });
  it('streams each chosen namespace and passes the label selector', async () => {
    renderWidget({ ...defaultFilters(), namespaces: ['dev', 'prod'], labelSelector: 'app=web' });
    await waitFor(() => expect(streamResults).toHaveBeenCalledTimes(2));
    expect(streamResults.mock.calls.map(c => c[0])).toEqual(['/api/v1/namespaces/dev/pods', '/api/v1/namespaces/prod/pods']);
    expect(streamResults.mock.calls[0][3]).toEqual({ labelSelector: 'app=web' });
  });
  it('starts again when the refresh signal changes, and only then', async () => {
    const reportRefreshed = vi.fn();
    const filters = defaultFilters();
    const view = (signal: number) => (
      <MemoryRouter>
        <Widget instanceId="w" config={DEFAULT_REPORT} filters={filters} refreshSignal={signal} reportRefreshed={reportRefreshed} editing={false} kiosk={false} />
      </MemoryRouter>
    );
    const { rerender } = render(view(0));
    await waitFor(() => expect(streamResults).toHaveBeenCalledTimes(1));
    rerender(view(0));
    expect(streamResults).toHaveBeenCalledTimes(1);
    rerender(view(1));
    await waitFor(() => expect(streamResults).toHaveBeenCalledTimes(2));
  });
  it('narrows the rows by the dashboard namespace filter', async () => {
    streamResults.mockImplementation(async (_u: string, cb: (items: unknown[]) => void) => {
      cb([pod('a', 'prod'), pod('d1', 'dev')]);
      return () => undefined;
    });
    renderWidget({ ...defaultFilters(), namespaces: ['dev'] });
    await waitFor(() => expect(screen.getByText('d1')).toBeTruthy());
    expect(screen.queryByText('a')).toBeNull();
  });
  it('shows an error when the list is refused', async () => {
    streamResults.mockImplementation(async (_u: string, _cb: unknown, errCb: (e: unknown) => void) => {
      errCb(Object.assign(new Error('no'), { status: 403 }));
      return () => undefined;
    });
    renderWidget();
    await waitFor(() => expect(screen.getByText(/may not list pods/)).toBeTruthy());
  });
  it('stops the streams on unmount', async () => {
    const cancel = vi.fn();
    streamResults.mockImplementation(async () => cancel);
    const { unmount } = renderWidget();
    await waitFor(() => expect(streamResults).toHaveBeenCalled());
    await act(async () => {
      await Promise.resolve();
    });
    unmount();
    expect(cancel).toHaveBeenCalled();
  });
});

describe('kind discovery', () => {
  it('lists built-in kinds first and custom kinds after', async () => {
    request.mockImplementation(async (path: string) => {
      if (path === '/api/v1') return { resources: [{ name: 'pods', kind: 'Pod', namespaced: true, verbs: ['list'] }, { name: 'pods/log', kind: 'Pod', verbs: ['get'] }] };
      if (path === '/apis') return { groups: [{ name: 'apps', preferredVersion: { version: 'v1' } }, { name: 'cert-manager.io', preferredVersion: { version: 'v1' } }, { name: 'broken.io', preferredVersion: { version: 'v1' } }] };
      if (path === '/apis/apps/v1') return { resources: [{ name: 'deployments', kind: 'Deployment', namespaced: true, verbs: ['list'] }] };
      if (path === '/apis/cert-manager.io/v1') return { resources: [{ name: 'certificates', kind: 'Certificate', namespaced: true, verbs: ['list'] }] };
      throw new Error('boom');
    });
    const kinds = await fetchKinds(p => request(p));
    expect(kinds.map(k => k.kind)).toEqual(['Pod', 'Deployment', 'Certificate']);
    expect(kinds.map(k => k.custom)).toEqual([false, false, true]);
  });
  it('builds list paths', () => {
    expect(listPath({ group: '', version: 'v1', plural: 'pods', kind: 'Pod', namespaced: true })).toBe('/api/v1/pods');
    expect(listPath({ group: 'apps', version: 'v1', plural: 'deployments', kind: 'Deployment', namespaced: true }, 'a b')).toBe('/apis/apps/v1/namespaces/a%20b/deployments');
    expect(listPath({ group: '', version: 'v1', plural: 'nodes', kind: 'Node', namespaced: false }, 'x')).toBe('/api/v1/nodes');
  });
  it('removes duplicate kinds', () => {
    const k = { group: 'g', version: 'v1', plural: 'x', kind: 'X', namespaced: true, custom: true, label: 'X' };
    expect(sortKinds([k, k])).toHaveLength(1);
  });
});

describe('settings editor', () => {
  it('has the five steps and a live preview, and edits the draft', async () => {
    request.mockResolvedValue({ resources: [] });
    const onChange = vi.fn();
    render(
      <MemoryRouter>
        <ReportSettings config={DEFAULT_REPORT} onChange={onChange} />
      </MemoryRouter>
    );
    for (const name of ['Source', 'Columns', 'Filters', 'Grouping', 'Chart']) expect(screen.getByRole('button', { name })).toBeTruthy();
    await waitFor(() => expect(screen.getByText('a')).toBeTruthy()); // the preview
    fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add filter' }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ filters: [{ field: '', op: 'eq', value: '' }] }));
    fireEvent.click(screen.getByRole('button', { name: 'Grouping' }));
    fireEvent.click(screen.getByRole('button', { name: 'Summary' }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ reportType: 'summary' }));
  });
});
