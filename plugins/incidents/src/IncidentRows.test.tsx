import { createTheme, ThemeProvider } from '@mui/material/styles';
import { cleanup, render } from '@testing-library/react';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@kinvolk/headlamp-plugin/lib', () => ({
  Router: { createRouteURL: (name: string, p?: { id?: string }) => `/${name}/${p?.id ?? ''}` },
  ApiProxy: { request: vi.fn() },
  ConfigStore: class {},
}));

import { IncidentHero } from './IncidentHero';
import { bySeverityFirst, IncidentRows } from './IncidentRows';
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
    expect(container.querySelectorAll('[data-incident-row]')).toHaveLength(4);
    const marks = Array.from(container.querySelectorAll('svg[data-severity]')).map(s =>
      s.getAttribute('data-severity')
    );
    expect(marks).toEqual(['critical', 'critical', 'warning', 'other']);
    expect(container.textContent).toContain('Analysed');
  });
  it('shows Run again on a failed row only when a re-run is given', () => {
    const failed = [d('9', 'critical', 'failed')];
    expect(wrap(<IncidentRows rows={failed} />).queryByText('Run again')).toBeNull();
    cleanup();
    expect(
      wrap(<IncidentRows rows={failed} onRerun={async () => {}} />).getByText('Run again')
    ).toBeTruthy();
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
