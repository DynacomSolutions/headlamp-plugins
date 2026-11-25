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
import { PieChart } from '../sunburst/PieChart';
import { SunburstChart } from '../sunburst/SunburstChart';
import { AisView } from './AisView';
import { agentsToSunburst, DIRECT, PROVIDER_ORDER, providerIndex } from './charts';
import { joinAis, LIMIT_PROVIDER, PROVIDER_NAME } from './join';
import {
  isAisSource,
  labelLogo,
  poolLabelLogo,
  ProviderIcon,
  providerLogoIn,
  providerLogoKey,
} from './providerIcon';
import { PROVIDER_LOGOS } from './providerIcons.generated';

afterEach(cleanup);

const themed = (ui: React.ReactNode, mode: 'dark' | 'light' = 'dark') => (
  <MemoryRouter>
    <ThemeProvider theme={createTheme({ palette: { mode } })}>
      <LinkContext.Provider value={{ base: '/c/main', dashboard: 'ops', tabs: ['overview'] }}>
        {ui}
      </LinkContext.Provider>
    </ThemeProvider>
  </MemoryRouter>
);

/** Every provider name that the live AIS feed uses: the group titles, the gateway groups and the keys. */
const LIVE_NAMES = [
  // The group titles of the console (join.ts).
  'Anthropic',
  'OpenAI',
  'Kimi',
  'OpenCode Go',
  'xAI',
  'Z.ai',
  'Pi',
  // The provider groups of the gateway usage panel.
  'Claude',
  'Codex',
  'xAI',
  'OpenCode',
  'Z.ai',
  'Kimi',
  'Ali',
];

describe('provider logos', () => {
  it('has a real logo for every provider that the live feed names', () => {
    for (const name of LIVE_NAMES) {
      const key = providerLogoKey(name);
      expect(key, name).toBeDefined();
      expect(PROVIDER_LOGOS[key as string], name).toBeDefined();
    }
  });

  it('has a logo for every provider of the login panel, the limits panel and the gateway order', () => {
    for (const name of Object.values(PROVIDER_NAME))
      expect(providerLogoKey(name), name).toBeDefined();
    for (const key of Object.keys(PROVIDER_NAME)) expect(providerLogoKey(key), key).toBeDefined();
    for (const key of Object.values(LIMIT_PROVIDER))
      expect(providerLogoKey(key), key).toBeDefined();
    for (const key of PROVIDER_ORDER) expect(providerLogoKey(key), key).toBeDefined();
  });

  it('gives each logo real path data, a brand name and a 24 unit view', () => {
    for (const [id, logo] of Object.entries(PROVIDER_LOGOS)) {
      expect(logo.brand, id).not.toBe('');
      expect(logo.paths.length, id).toBeGreaterThan(0);
      for (const p of logo.paths) expect(p.d.length, id).toBeGreaterThan(20);
    }
  });

  it('knows the Claude pool, the aliases and a label that holds a provider name', () => {
    expect(providerLogoKey('agent-pool')).toBe('claude');
    expect(providerLogoKey('Codex')).toBe('openai');
    expect(providerLogoKey('grok')).toBe('xai');
    expect(providerLogoKey('OpenCode Go')).toBe('opencode');
    expect(providerLogoKey('Google')).toBe('google');
    expect(providerLogoIn('claude-dynacom')).toBe('claude');
    expect(providerLogoIn('Anthropic / dynacom')).toBe('anthropic');
    expect(providerLogoIn('t3-codex-dynacom')).toBe('openai');
  });

  it('draws no logo for a name that is no provider, never a letter tile', () => {
    expect(providerLogoKey('dynacom')).toBeUndefined();
    expect(providerLogoKey(DIRECT)).toBeUndefined();
    expect(providerLogoIn('Direct')).toBeUndefined();
    expect(labelLogo('dynacom', 12)).toBeNull();
    const c = render(themed(<ProviderIcon name="dynacom" />)).container;
    expect(c.querySelector('svg[data-provider-icon]')).toBeNull();
    expect(c.textContent).toBe('');
  });

  it('draws the logo as inline SVG paths with no image address', () => {
    const c = render(themed(<ProviderIcon name="OpenAI" size={16} />)).container;
    const svg = c.querySelector('svg[data-provider-icon="openai"]') as SVGElement;
    expect(svg.getAttribute('width')).toBe('16');
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.querySelectorAll('path').length).toBeGreaterThan(0);
    expect(c.querySelector('img, image, use')).toBeNull();
  });

  it('keeps the colour of a coloured logo and uses the text colour for a plain one', () => {
    const claude = render(themed(<ProviderIcon name="Claude" />)).container;
    expect(claude.querySelector('path')?.getAttribute('fill')).toBe('#D97757');
    cleanup();
    const openai = render(themed(<ProviderIcon name="OpenAI" />)).container;
    expect(openai.querySelector('svg')?.getAttribute('fill')).toBe('currentColor');
    expect(openai.querySelector('path')?.hasAttribute('fill')).toBe(false);
  });

  it('knows the source of the AIS panels', () => {
    expect(isAisSource('ais-console')).toBe(true);
    expect(isAisSource('ais')).toBe(true);
    expect(isAisSource('runners')).toBe(false);
    expect(isAisSource(undefined)).toBe(false);
  });
});

const LINK = 'https://console.example.com/limits';
const lim = (label: string, detail: string, f: number) => ({
  label,
  detail,
  value: `${Math.round(f * 100)}%`,
  fraction: f,
  status: 'ok',
  link: LINK,
});

describe('logos in the AIS widget', () => {
  const limits = parsePanel({
    version: 1,
    id: 'limits',
    title: 'Limits',
    status: 'ok',
    summary: '',
    stats: [],
    rows: [
      lim('Anthropic / blue', 'Weekly', 0.4),
      lim('Anthropic / solo', 'Weekly', 0.3),
      lim('OpenAI / red', 'Weekly', 0.5),
      lim('Kimi / red', 'Weekly', 0.2),
      lim('OpenCode Go / red', 'Weekly', 0.2),
      lim('xAI / red', 'Weekly', 0.2),
      lim('Z.ai / red', 'Weekly', 0.2),
    ],
  });
  const identities = parsePanel({
    version: 1,
    id: 'identities',
    title: 'Identities',
    status: 'ok',
    summary: '',
    stats: [],
    rows: [
      { label: 'pi / solo', detail: 'Logged in', value: 'Logged in', status: 'ok', link: LINK },
    ],
  });
  const swap = parsePanel({
    version: 1,
    id: 'claude-swap',
    title: 'Swap',
    status: 'ok',
    summary: '',
    stats: [],
    rows: [
      {
        label: 'agent-pool / blue',
        detail: 'Active, weekly',
        value: '40%',
        fraction: 0.4,
        status: 'ok',
        link: LINK,
      },
    ],
  });
  const draw = (mode: 'dark' | 'light' = 'dark', width = 0) => {
    const model = joinAis({ limits, identities, swap });
    return render(
      themed(
        <div style={{ width }}>
          <AisView model={model} sourceId="ais-console" kiosk={false} editing={false} />
        </div>,
        mode
      )
    ).container;
  };

  it('shows the logo of every provider group next to its name', () => {
    const c = draw();
    const titles = Array.from(c.querySelectorAll('[data-group-kind="provider"]')).map(
      h => h.textContent ?? ''
    );
    expect(titles.length).toBeGreaterThanOrEqual(6);
    for (const h of Array.from(c.querySelectorAll('[data-group-kind="provider"]'))) {
      const icon = h.querySelector('[data-provider-icon]');
      expect(icon, h.textContent ?? '').not.toBeNull();
      // The logo comes before the name.
      expect(
        (icon as Element).compareDocumentPosition(h.querySelector('span') as Element) &
          Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy();
    }
    const keys = Array.from(c.querySelectorAll('[data-group-kind="provider"] [data-provider-icon]'))
      .map(i => i.getAttribute('data-provider-icon'))
      .sort();
    expect(keys).toEqual(['anthropic', 'kimi', 'openai', 'opencode', 'pi', 'xai', 'zai'].sort());
  });

  it('shows the Claude logo on the pool line, in the name column', () => {
    const c = draw();
    const pool = c.querySelector('[data-ais-row^="pool:"], [data-ais-row="agent-pool"]');
    expect(pool).not.toBeNull();
    const icon = (pool as Element).querySelector('[data-pool-icon] [data-provider-icon]');
    expect(icon?.getAttribute('data-provider-icon')).toBe('claude');
    expect((pool as Element).querySelector('[data-ais-label]')?.contains(icon as Element)).toBe(
      true
    );
  });

  it('draws the same in the light theme and at the narrow width, with no logo outside the name column', () => {
    for (const [mode, width] of [
      ['light', 0],
      ['dark', 420],
    ] as const) {
      cleanup();
      const c = draw(mode, width);
      expect(c.querySelectorAll('[data-provider-icon]').length).toBeGreaterThanOrEqual(7);
      // A lane (bar, countdown, percentage) never holds a logo, so the columns stay as they are.
      expect(c.querySelectorAll('[data-lane] [data-provider-icon]')).toHaveLength(0);
      expect(c.querySelectorAll('[data-bar] [data-provider-icon]')).toHaveLength(0);
    }
  });
});

describe('logos in the charts', () => {
  it('shows the provider logo in front of each gateway legend row', () => {
    const slices = [
      { key: 'a', label: 'agents-claude', group: 'Claude', value: 90, valueText: '90' },
      { key: 'b', label: 'x-codex', group: 'Codex', value: 10, valueText: '10' },
      { key: 'c', label: 'x-ali', group: 'Ali', value: 5, valueText: '5' },
    ];
    const c = render(
      themed(
        <PieChart
          slices={slices}
          groupIndex={g => providerIndex(g, [])}
          title="Tokens"
          totalText="105 tokens"
          groupIcon={labelLogo}
        />
      )
    ).container;
    const keys = slices.map(s =>
      c
        .querySelector(`[data-legend-row="${s.key}"] [data-provider-icon]`)
        ?.getAttribute('data-provider-icon')
    );
    expect(keys).toEqual(['claude', 'openai', 'alibaba']);
  });

  it('shows the Claude logo for the pool of the agents legend and no logo for Direct', () => {
    const agents = parsePanel({
      version: 1,
      id: 'agents',
      title: 'Agents',
      status: 'ok',
      summary: '',
      stats: [],
      rows: [
        {
          label: 'a1',
          detail: '',
          value: '1',
          status: 'ok',
          pool: 'agent-pool',
          identity: 'myriad',
          provider: 'claude',
        },
        {
          label: 'a2',
          detail: '',
          value: '1',
          status: 'ok',
          pool: null,
          identity: 'dynacom',
          provider: 'codex',
        },
      ],
    } as unknown as Parameters<typeof parsePanel>[0]);
    const data = agentsToSunburst(agents, null);
    const pools = new Set(data.nodes?.map(n => n.label).filter(l => l !== DIRECT));
    const c = render(
      themed(
        <SunburstChart
          data={data}
          title="Agents"
          unit="agents"
          format={v => String(v)}
          labelIcon={poolLabelLogo(pools)}
        />
      )
    ).container;
    const rows = Array.from(c.querySelectorAll('[data-legend-node]'));
    expect(rows.length).toBe(data.nodes?.length);
    for (const n of data.nodes ?? []) {
      const icon = c.querySelector(`[data-legend-node="${n.key}"] [data-provider-icon]`);
      expect(icon !== null, n.label).toBe(n.label !== DIRECT);
    }
  });
});
