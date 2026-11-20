import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@kinvolk/headlamp-plugin/lib', () => ({
  Router: {
    createRouteURL: (name: string, params?: { id?: string }) =>
      `/c/test/${name}${params?.id ? '/' + params.id : ''}`,
  },
}));
vi.mock('@kinvolk/headlamp-plugin/lib/CommonComponents', () => ({
  SectionBox: ({ title, children }: any) => (
    <section>
      <div>{title}</div>
      {children}
    </section>
  ),
}));
vi.mock('./a2ui', () => ({ A2uiRenderer: () => null }));
vi.mock('./ChatPage', () => ({ ChatPage: () => null }));
vi.mock('./AgentActions', () => ({ AgentActions: () => null }));
vi.mock('./LaunchPages', () => ({ LaunchesPage: () => null }));
vi.mock('./chat-data', () => ({ createChat: vi.fn(async () => 'chat1') }));
vi.mock('./data', () => ({
  useSettings: () => ({}),
  useDiagnoses: () => ({
    loading: false,
    error: null,
    data: [
      {
        id: 'd1',
        createdAt: '2026-01-01T00:00:00Z',
        status: 'done',
        source: 'alert',
        alertName: 'HighCPU',
        severity: 'critical',
        likelyCause: 'x',
        confidence: 'high',
        resolved: false,
      },
    ],
  }),
  useDiagnosis: () => ({
    loading: false,
    error: null,
    data: { id: 'd1', status: 'done', a2ui: [] },
  }),
}));

import { IncidentPage, IncidentsPage } from './pages';

const loc = (
  <Route
    path="/c/test"
    render={({ location }) => <div data-testid="loc">{location.pathname}</div>}
  />
);

describe('incidents pages use cluster-scoped URLs', () => {
  it('links a diagnosis row and opens it on click', async () => {
    render(
      <MemoryRouter initialEntries={['/list']}>
        <Route path="/list" component={IncidentsPage} />
        {loc}
      </MemoryRouter>
    );
    expect(screen.getByRole('link', { name: 'HighCPU' }).getAttribute('href')).toBe(
      '/c/test/incident/d1'
    );
    fireEvent.click(screen.getByText('x'));
    expect((await screen.findByTestId('loc')).textContent).toBe('/c/test/incident/d1');
  });

  it('links back to the list and opens the new chat after Ask', async () => {
    render(
      <MemoryRouter initialEntries={['/d/d1']}>
        <Route path="/d/:id" component={IncidentPage} />
        {loc}
      </MemoryRouter>
    );
    expect(screen.getByRole('link', { name: 'Back to incidents' }).getAttribute('href')).toBe(
      '/c/test/incidents'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Ask about this incident' }));
    await waitFor(() =>
      expect(screen.getByTestId('loc').textContent).toBe('/c/test/incidents-chat-thread/chat1')
    );
  });
});
