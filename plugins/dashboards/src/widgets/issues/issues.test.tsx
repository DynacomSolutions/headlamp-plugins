import { createTheme, ThemeProvider } from '@mui/material/styles';
import { cleanup, render } from '@testing-library/react';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@kinvolk/headlamp-plugin/lib', () => ({
  ApiProxy: { request: vi.fn(), clusterRequest: vi.fn() },
  ConfigStore: class {
    useConfig() {
      return () => undefined;
    }
  },
}));

import { LinkContext } from '../../links';
import { parsePanel } from '../panels/model';
import { IssuesView } from './IssuesView';
import { joinIssues } from './join';

afterEach(cleanup);

const NOW = Date.parse('2026-11-22T12:00:00');
const TODAY = '2026-11-22T03:00:00';
const YESTERDAY = '2026-11-21T03:00:00';

const panel = (id: string, rows: unknown[]) =>
  parsePanel({ version: 1, id, title: id, status: 'ok', summary: '', stats: [], rows });

const alert = (
  name: string,
  target: string,
  state: 'firing' | 'pending',
  severity: string,
  more: Record<string, string> = {}
) => ({
  label: name,
  detail: '',
  value: state,
  status: state === 'firing' ? (severity === 'critical' ? 'crit' : 'warn') : 'unknown',
  link: '/c/{cluster}/alerting/status',
  meta: { kind: 'alert', group: `${name}|${target}`, target, severity, state, ...more },
});

const incident = (
  id: string,
  name: string,
  target: string,
  o: {
    severity?: string;
    state?: string;
    agent?: string;
    cause?: string;
    resolvedAt?: string;
    at?: string;
  } = {}
) => ({
  label: name,
  detail: o.cause ?? '',
  value: o.resolvedAt ? 'resolved' : o.state === 'done' || !o.state ? 'open' : o.state,
  status: o.resolvedAt ? 'ok' : 'warn',
  link: `/c/{cluster}/incidents/${id}`,
  meta: {
    kind: 'incident',
    group: `${name}|${target}`,
    target,
    severity: o.severity ?? 'warning',
    state: o.state ?? 'done',
    agent: o.agent ?? 'diagnosed',
    at: o.at ?? '2026-11-22T01:00:00Z',
    resolvedAt: o.resolvedAt ?? '',
    id,
  },
});

const alerts = panel('alerts', [
  alert('KubeDeploymentDown', 'shop/web', 'firing', 'critical'),
  alert('KubeDeploymentDown', 'shop/web', 'firing', 'critical'),
  alert('ProbeSlow', 'a.example.com', 'pending', 'warning'),
  alert('ProbeSlow', 'b.example.com', 'pending', 'warning'),
  alert('DiskBusy', 'n1/sdb', 'firing', 'warning'),
]);
const incidents = panel('incidents', [
  incident('i1', 'KubeDeploymentDown', 'shop/web', { severity: 'critical', cause: 'Crash loop' }),
  incident('i2', 'KubeDeploymentDown', 'shop/web', {
    severity: 'critical',
    agent: 'working',
    state: 'running',
    at: '2026-11-22T02:00:00Z',
  }),
  incident('i3', 'ProbeSlow', 'a.example.com', { agent: 'failed', state: 'failed' }),
  incident('i4', 'OldIssue', 'ns/x', { resolvedAt: TODAY, cause: 'Fixed' }),
  incident('i5', 'OldIssue', 'ns/x', { resolvedAt: TODAY, cause: 'Fixed' }),
  incident('i6', 'LongGone', 'ns/y', { resolvedAt: YESTERDAY }),
]);

const model = () => joinIssues({ alerts, incidents }, NOW);
const find = (name: string, target: string) =>
  model().groups.find(g => g.name === name && g.target === target)!;

describe('joinIssues', () => {
  it('puts the same alert name on the same target into one group and counts alerts and incidents', () => {
    const g = find('KubeDeploymentDown', 'shop/web');
    expect(g).toMatchObject({ alerts: 2, incidents: 2, count: 4, state: 'firing', status: 'crit' });
  });

  it('keeps one alert name on two targets as two groups', () => {
    const names = model().groups.filter(g => g.name === 'ProbeSlow');
    expect(names.map(g => g.target).sort()).toEqual(['a.example.com', 'b.example.com']);
  });

  it('says the agent works when any incident of the group has a diagnosis that runs', () => {
    expect(find('KubeDeploymentDown', 'shop/web').agent).toBe('working');
  });

  it('shows the likely cause of a diagnosed group and none for the other states', () => {
    const m = joinIssues(
      {
        alerts: panel('alerts', []),
        incidents: panel('incidents', [incident('i1', 'A', 't', { cause: 'Disk full' })]),
      },
      NOW
    );
    expect(m.groups[0]).toMatchObject({ agent: 'diagnosed', cause: 'Disk full', state: 'open' });
    expect(find('ProbeSlow', 'a.example.com')).toMatchObject({ agent: 'failed', cause: '' });
    expect(find('ProbeSlow', 'b.example.com').agent).toBe('none');
  });

  it('shows a skipped incident as not investigated, and ranks it under a failed one', () => {
    const one = joinIssues(
      {
        alerts: panel('alerts', []),
        incidents: panel('incidents', [incident('s1', 'Quiet', 't', { agent: 'skipped', state: 'skipped' })]),
      },
      NOW
    );
    expect(one.groups[0]).toMatchObject({ agent: 'skipped', cause: '' });
    const both = joinIssues(
      {
        alerts: panel('alerts', []),
        incidents: panel('incidents', [
          incident('s1', 'Mixed', 't', { agent: 'skipped', state: 'skipped' }),
          incident('s2', 'Mixed', 't', { agent: 'failed', state: 'failed' }),
        ]),
      },
      NOW
    );
    expect(both.groups[0]!.agent).toBe('failed');
  });

  it('shows a group of incidents resolved today as resolved, and drops older ones', () => {
    const g = find('OldIssue', 'ns/x');
    expect(g).toMatchObject({ state: 'resolved', status: 'ok', count: 2 });
    expect(model().groups.some(x => x.name === 'LongGone')).toBe(false);
  });

  it('ignores a resolved incident of a group that is still active', () => {
    const m = joinIssues(
      {
        alerts: panel('alerts', [alert('A', 't', 'firing', 'warning')]),
        incidents: panel('incidents', [incident('i1', 'A', 't', { resolvedAt: TODAY })]),
      },
      NOW
    );
    expect(m.groups).toHaveLength(1);
    expect(m.groups[0]).toMatchObject({ state: 'firing', count: 1, incidents: 0 });
  });

  it('sorts the worst group first: severity, then state, then count', () => {
    const m = model();
    expect(m.groups.map(g => `${g.name}/${g.target}`)).toEqual([
      'KubeDeploymentDown/shop/web',
      'DiskBusy/n1/sdb',
      'ProbeSlow/a.example.com',
      'ProbeSlow/b.example.com',
      'OldIssue/ns/x',
    ]);
  });

  it('builds the tiles', () => {
    const m = model();
    expect(m.alertStats.map(s => [s.label, s.value])).toEqual([
      ['Critical', '2'],
      ['Warning', '1'],
      ['Pending', '2'],
    ]);
    // Open does not count the incident that an agent works on.
    expect(m.incidentStats.map(s => [s.label, s.value])).toEqual([
      ['Open', '2'],
      ['In progress', '1'],
      ['Resolved today', '2'],
    ]);
    expect(m.summary).toBe('5 issues: 2 firing, 2 pending, 0 open, 1 resolved today');
    expect(m.status).toBe('crit');
  });

  it('falls back to the alert name for an older agent with no meta', () => {
    const m = joinIssues(
      {
        alerts: parsePanel({
          version: 1,
          id: 'alerts',
          rows: [{ label: 'A', detail: '', value: 'firing', status: 'crit' }],
        }),
        incidents: parsePanel({
          version: 1,
          id: 'incidents',
          rows: [
            {
              label: 'A',
              detail: 'Cause',
              value: 'open',
              status: 'crit',
              link: '/c/{cluster}/incidents',
            },
            { label: 'B', detail: '', value: 'running', status: 'warn' },
          ],
        }),
      },
      NOW
    );
    expect(m.groups.find(g => g.name === 'A')).toMatchObject({
      count: 2,
      agent: 'diagnosed',
      state: 'firing',
    });
    expect(m.groups.find(g => g.name === 'B')).toMatchObject({ agent: 'working', state: 'open' });
  });

  it('survives missing panels', () => {
    expect(joinIssues({}, NOW).groups).toEqual([]);
    expect(joinIssues({}, NOW).summary).toBe('No alerts or incidents');
    expect(joinIssues({ alerts }, NOW).groups.length).toBeGreaterThan(0);
  });

  it('links a group with an incident to that incident, and an alert-only group to the Incidents page', () => {
    expect(find('KubeDeploymentDown', 'shop/web').link).toBe('/c/{cluster}/incidents/i2');
    expect(find('DiskBusy', 'n1/sdb').link).toBe('/c/{cluster}/incidents');
  });
});

const wrap = (ui: React.ReactNode, tabs: string[] = ['overview']) => (
  <MemoryRouter>
    <ThemeProvider theme={createTheme({ palette: { mode: 'dark' } })}>
      <LinkContext.Provider value={{ base: '/c/main', dashboard: 'ops', tabs }}>
        {ui}
      </LinkContext.Provider>
    </ThemeProvider>
  </MemoryRouter>
);
const view = (editing = false, tabs?: string[]) =>
  render(wrap(<IssuesView model={model()} sourceId="agent" editing={editing} />, tabs)).container;

describe('IssuesView', () => {
  it('keeps the tiles outside the one scroll area and draws every group', () => {
    const c = view();
    const scroll = c.querySelectorAll('[data-scroll-area]');
    expect(scroll).toHaveLength(1);
    expect(scroll[0].contains(c.querySelector('[data-stats]'))).toBe(false);
    expect(scroll[0].querySelectorAll('[data-issue-group]')).toHaveLength(5);
    expect(c.querySelectorAll('[data-stats]')).toHaveLength(2);
    expect(c.textContent).not.toMatch(/\+\s*\d+\s*more/i);
    expect(c.textContent).not.toMatch(/\bother\b/i);
  });

  it('gives both tile rows one numeral size', () => {
    const c = view();
    const sizes = [...c.querySelectorAll('[data-stat] > div:first-child')].map(
      e => getComputedStyle(e).fontSize
    );
    expect(sizes).toHaveLength(6);
    expect(new Set(sizes).size).toBe(1);
  });

  it('draws the count, the state, the agent chip and the cause on a group row', () => {
    const c = view();
    const row = c.querySelector('[data-issue-group="KubeDeploymentDown|shop/web"]')!;
    expect(row.querySelector('[data-issue-count]')!.textContent).toBe('4');
    expect(row.querySelector('[data-issue-state-word]')!.textContent).toBe('Firing');
    expect(row.querySelector('[data-issue-agent]')!.textContent).toBe('Agent working');
    expect(row.querySelector('[data-issue-target]')!.textContent).toBe('shop/web');
    const diagnosed = joinIssues(
      { incidents: panel('incidents', [incident('i1', 'A', 't', { cause: 'Disk full' })]) },
      NOW
    );
    const d = render(
      wrap(<IssuesView model={diagnosed} sourceId="agent" editing={false} />)
    ).container;
    expect(d.querySelector('[data-issue-agent]')!.textContent).toBe('Diagnosed');
    expect(d.querySelector('[data-issue-cause]')!.textContent).toBe('Disk full');
  });

  it('links to the Incidents page of Headlamp, or to the Incidents tab', () => {
    const hrefs = [...view().querySelectorAll('a')].map(a => a.getAttribute('href'));
    expect(hrefs).toContain('/c/main/incidents/i2');
    expect(hrefs).toContain('/c/main/incidents');
    expect(hrefs.every(h => h!.startsWith('/c/main/incidents'))).toBe(true);
    cleanup();
    const tab = [...view(false, ['overview', 'incidents']).querySelectorAll('a')].map(a =>
      a.getAttribute('href')
    );
    expect(tab).toContain('/c/main/dashboards/ops/incidents');
    expect(tab).toContain('/c/main/incidents/i2');
  });

  it('draws no link in the editor', () => {
    expect(view(true).querySelectorAll('a')).toHaveLength(0);
  });
});
