import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import React from 'react';
import { MemoryRouter, Route, useLocation } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { LoadState } from './data';
import { FIXTURE } from './fixture';
import { parseReport } from './model';
import { UpdatesView } from './pages';

vi.mock('@kinvolk/headlamp-plugin/lib/CommonComponents', () => ({
  SectionBox: ({ title, children }: any) => (
    <section aria-label={title}>
      <h2>{title}</h2>
      {children}
    </section>
  ),
}));
vi.mock('./data', () => ({ useReport: vi.fn() }));

const NOW = Date.parse('2026-10-11T07:00:00Z');
const loaded = (text: string): LoadState => ({
  phase: 'loaded',
  namespace: 'monitoring',
  result: parseReport(text),
});
const ok = loaded(JSON.stringify(FIXTURE));

let here = '';
function Where() {
  const l = useLocation();
  here = l.pathname + l.search;
  return null;
}

function renderAt(url: string, state: LoadState, now = NOW) {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Route path="/updates/:id?">
        <UpdatesView state={state} now={now} />
      </Route>
      <Where />
    </MemoryRouter>
  );
}

describe('list view', () => {
  it('shows summary counts, server version and the skewed node', () => {
    renderAt('/updates', ok);
    const counts = screen.getByRole('group', { name: 'Update counts' });
    expect(within(counts).getByText('Security').parentElement).toHaveTextContent('1');
    expect(screen.getByText('Kubernetes server').nextElementSibling).toHaveTextContent(
      'v1.34.6+k3s1'
    );
    expect(screen.getByText(/worker-2: v1\.35\.0\+k3s1 \(newer than server\)/)).toBeInTheDocument();
    expect(screen.queryByText(/The report is .* old/)).not.toBeInTheDocument();
  });
  it('warns when the report is stale', () => {
    renderAt('/updates', ok, NOW + 14 * 3_600_000);
    expect(screen.getByText(/The report is 15 h 0 min old/)).toBeInTheDocument();
  });
  it('shows the blocked k3s row with its blocker, required version and blocked-by link', () => {
    renderAt('/updates', ok);
    const row = screen.getByRole('link', { name: 'k3s' }).closest('tr')!;
    expect(within(row).getByText('Blocked')).toBeInTheDocument();
    expect(within(row).getByRole('link', { name: /KubeVirt v1.9 supports/ })).toHaveAttribute(
      'href',
      'https://example.com/kubevirt/support'
    );
    expect(within(row).getByText('Requires kubevirt>=1.10.0')).toBeInTheDocument();
  });
  it('is filtered from the URL alone and writes filters back with replace', () => {
    renderAt('/updates?status=blocked', ok);
    expect(screen.getByRole('status')).toHaveTextContent('Showing 1 of 4');
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search' }), {
      target: { value: 'kube' },
    });
    expect(here).toBe('/updates?q=kube&status=blocked');
  });
  it('sorts via the header and records it in the URL', () => {
    renderAt('/updates', ok);
    fireEvent.click(screen.getByRole('button', { name: 'Status' }));
    expect(here).toBe('/updates?sort=status');
  });
});

describe('detail view', () => {
  it('opens from the path and shows the blocker chain', () => {
    renderAt('/updates/k3s', ok);
    expect(screen.getByRole('heading', { name: 'k3s' })).toBeInTheDocument();
    expect(screen.getByText('Blocked by')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'KubeVirt' }).length).toBeGreaterThan(0);
  });
  it('navigates from the list to the detail path, keeping the filters', () => {
    renderAt('/updates?category=platform', ok);
    fireEvent.click(screen.getByRole('link', { name: 'KubeVirt' }));
    expect(here).toBe('/updates/kubevirt?category=platform');
    expect(screen.getByText('Blocks')).toBeInTheDocument();
  });
  it('shows the component error', () => {
    renderAt('/updates/mystery', ok);
    expect(screen.getByRole('alert')).toHaveTextContent('upstream returned 404');
  });
  it('handles an unknown id', () => {
    renderAt('/updates/nope', ok);
    expect(screen.getByText(/no component with id "nope"/)).toBeInTheDocument();
  });
});

describe('failure states', () => {
  it('missing ConfigMap', () => {
    renderAt('/updates', { phase: 'missing' });
    expect(screen.getByRole('alert')).toHaveTextContent('No update report found');
  });
  it('schema mismatch', () => {
    renderAt('/updates', loaded(JSON.stringify({ ...FIXTURE, schemaVersion: 9 })));
    expect(screen.getByRole('alert')).toHaveTextContent('Unsupported report version');
  });
  it('malformed JSON', () => {
    renderAt('/updates', loaded('{oops'));
    expect(screen.getByRole('alert')).toHaveTextContent('not valid JSON');
  });
  it('forbidden', () => {
    renderAt('/updates', { phase: 'forbidden', message: 'denied' });
    expect(screen.getByRole('alert')).toHaveTextContent('not allowed');
  });
});
