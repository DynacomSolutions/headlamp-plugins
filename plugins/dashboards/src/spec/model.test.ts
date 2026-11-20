import { describe, expect, it } from 'vitest';
import {
  baseWidgetType,
  countWidgets,
  defaultFilters,
  emptySpec,
  migrateSpec,
  parseSpec,
  serialiseSpec,
  slugify,
  SPEC_VERSION,
  SpecError,
  SpecVersionError,
  uniqueSlug,
} from './model';

describe('slugify and uniqueSlug', () => {
  it('makes a DNS label', () => {
    expect(slugify('My Ops Dashboard!')).toBe('my-ops-dashboard');
    expect(slugify('  --Café  ')).toBe('cafe');
    expect(slugify('')).toBe('dashboard');
    expect(slugify('!!!', 'tab')).toBe('tab');
    expect(slugify('x'.repeat(100))).toHaveLength(63);
  });
  it('adds a number to a taken name', () => {
    expect(uniqueSlug('ops', [])).toBe('ops');
    expect(uniqueSlug('ops', ['ops'])).toBe('ops-2');
    expect(uniqueSlug('ops', ['ops', 'ops-2'])).toBe('ops-3');
    expect(uniqueSlug('x'.repeat(63), ['x'.repeat(63)])).toHaveLength(63);
  });
});

describe('migrateSpec', () => {
  it('fills defaults for a minimal spec', () => {
    const { spec, migrated } = migrateSpec({ title: 'Ops' });
    // A spec with no version counts as version 1.
    expect(migrated).toBe(true);
    expect(spec.version).toBe(SPEC_VERSION);
    expect(spec.tabs).toHaveLength(1);
    expect(spec.tabs[0].sections).toHaveLength(1);
    expect(spec.tabPosition).toBe('top');
    expect(spec.refreshSeconds).toBe(0);
    expect(spec.filters).toEqual(defaultFilters());
    expect(spec.kioskShowFilters).toBe(false);
  });

  it('keeps the kiosk filter option only when it is true', () => {
    expect(migrateSpec({ title: 'Ops', kioskShowFilters: true }).spec.kioskShowFilters).toBe(true);
    expect(migrateSpec({ title: 'Ops', kioskShowFilters: 'yes' }).spec.kioskShowFilters).toBe(
      false
    );
  });

  it('treats a missing version as version 1 and keeps valid content', () => {
    const { spec } = migrateSpec({
      title: 'Ops',
      tabPosition: 'left',
      refreshSeconds: 30,
      tabs: [
        {
          id: 'main',
          label: 'Main',
          icon: 'mdi:server',
          sections: [
            {
              id: 's1',
              title: 'A',
              mode: 'sticky-top',
              widgets: [{ id: 'w1', type: 'core.clock', x: 2, y: 1, w: 3, h: 2, config: { a: 1 } }],
            },
          ],
        },
      ],
    });
    expect(spec.tabPosition).toBe('left');
    expect(spec.refreshSeconds).toBe(30);
    expect(spec.tabs[0].sections[0].mode).toBe('sticky-top');
    expect(spec.tabs[0].sections[0].widgets[0]).toMatchObject({
      x: 2,
      y: 1,
      w: 3,
      h: 2,
      config: { a: 1 },
    });
  });

  it('repairs invalid values', () => {
    const { spec } = migrateSpec({
      title: 7,
      tabPosition: 'bottom',
      refreshSeconds: 7,
      filters: { range: '99y', namespaces: ['a', 3, ''] },
      tabs: [
        {
          label: 'T',
          sections: [
            {
              mode: 'weird',
              height: 5,
              widgets: [
                { type: '', x: 0 },
                { id: 'dup', type: 'a', x: 11, w: 6, h: 0 },
                { id: 'dup', type: 'b' },
                'nonsense',
              ],
            },
          ],
        },
        null,
      ],
    });
    expect(spec.title).toBe('Dashboard');
    expect(spec.tabPosition).toBe('top');
    expect(spec.refreshSeconds).toBe(0);
    expect(spec.filters.range).toBe('1h');
    expect(spec.filters.namespaces).toEqual(['a']);
    const section = spec.tabs[0].sections[0];
    expect(section.mode).toBe('flow');
    expect(section.height).toBe(120);
    expect(section.widgets).toHaveLength(2);
    // x is kept inside the 12 column grid, h is at least 1, ids are unique.
    expect(section.widgets[0].x + section.widgets[0].w).toBeLessThanOrEqual(12);
    expect(section.widgets[0].h).toBe(1);
    expect(new Set(section.widgets.map(w => w.id)).size).toBe(2);
    expect(spec.tabs).toHaveLength(1);
  });

  it('gives duplicate tab ids new ids', () => {
    const { spec } = migrateSpec({
      tabs: [
        { id: 'a', label: 'A' },
        { id: 'a', label: 'B' },
      ],
    });
    expect(new Set(spec.tabs.map(t => t.id)).size).toBe(2);
  });

  it('refuses a spec from a newer version and a non-object', () => {
    expect(() => migrateSpec({ version: SPEC_VERSION + 1 })).toThrow(SpecVersionError);
    expect(() => migrateSpec([])).toThrow(SpecError);
    expect(() => migrateSpec(null)).toThrow(SpecError);
  });

  it('runs the migration hook (a version 0 spec is refused without a step)', () => {
    expect(() => migrateSpec({ version: 0 })).toThrow('No migration from spec version 0');
  });
});

describe('parseSpec and serialiseSpec', () => {
  it('round trips', () => {
    const spec = emptySpec('Ops');
    const again = parseSpec(serialiseSpec(spec)).spec;
    expect(again).toEqual(spec);
  });
  it('rejects invalid JSON', () => {
    expect(() => parseSpec('{')).toThrow('not valid JSON');
  });
  it('counts widgets', () => {
    expect(countWidgets(emptySpec('x'))).toBe(0);
  });
});

describe('palette types of panel sources', () => {
  const widget = (type: string, config: Record<string, unknown> = {}) => ({
    version: 1,
    title: 'Ops',
    tabs: [
      {
        id: 'main',
        label: 'Main',
        sections: [
          { id: 's', title: 'S', widgets: [{ id: 'w', type, config, x: 0, y: 0, w: 4, h: 4 }] },
        ],
      },
    ],
  });
  const first = (input: unknown) => migrateSpec(input).spec.tabs[0].sections[0].widgets[0];

  it('splits a variant type into the base type and the source', () => {
    expect(baseWidgetType('agent.panel.my-app')).toEqual({ type: 'agent.panel', source: 'my-app' });
    expect(baseWidgetType('agent.sunburst.x_1')).toEqual({ type: 'agent.sunburst', source: 'x_1' });
    expect(baseWidgetType('agent.panel')).toBeNull();
    expect(baseWidgetType('core.header')).toBeNull();
    expect(baseWidgetType('agent.panel.Bad Name')).toBeNull();
  });
  it('loads a saved variant type as the base type with that source', () => {
    expect(first(widget('agent.panel.my-app', { panel: 'p' }))).toMatchObject({
      type: 'agent.panel',
      config: { panel: 'p', source: 'my-app' },
    });
    expect(first(widget('agent.sunburst.my-app'))).toMatchObject({
      type: 'agent.sunburst',
      config: { source: 'my-app' },
    });
  });
  it('keeps the source the widget was saved with', () => {
    expect(first(widget('agent.panel.my-app', { source: 'other' })).config.source).toBe('other');
  });
  it('leaves other types alone', () => {
    expect(first(widget('agent.panel', { source: 'agent' }))).toMatchObject({
      type: 'agent.panel',
      config: { source: 'agent' },
    });
  });
});

describe('tab icons', () => {
  const tab = (icon: unknown) =>
    migrateSpec({ title: 'Ops', tabs: [{ id: 't', label: 'T', icon, sections: [] }] }).spec.tabs[0]
      .icon;
  it('keeps a bundled icon', () => {
    expect(tab('mdi:server')).toBe('mdi:server');
  });
  it('replaces a name that is not bundled, so the browser never calls the Iconify API', () => {
    expect(tab('mdi:this-icon-is-not-bundled')).toBe('mdi:view-dashboard-outline');
    expect(tab('logos:github')).toBe('mdi:view-dashboard-outline');
    expect(tab('https://example.com/x.svg')).toBe('mdi:view-dashboard-outline');
    expect(tab(5)).toBe('mdi:view-dashboard-outline');
    expect(tab(undefined)).toBe('mdi:view-dashboard-outline');
  });
});

describe('header, footer and tab rail (spec version 2)', () => {
  it('gives an older spec an empty header and footer and the compact rail', () => {
    const { spec, migrated } = migrateSpec({
      version: 1,
      title: 'Old',
      tabPosition: 'left',
      tabs: [{ id: 'a', label: 'A', sections: [{ id: 's', widgets: [{ id: 'w', type: 'x' }] }] }],
    });
    expect(migrated).toBe(true);
    expect(spec.version).toBe(2);
    expect(spec.header).toEqual({
      sticky: false,
      show: 'both',
      section: {
        id: '@header',
        title: 'Header',
        showTitle: false,
        mode: 'flow',
        height: 400,
        widgets: [],
      },
    });
    expect(spec.footer.section.id).toBe('@footer');
    expect(spec.footer.section.widgets).toEqual([]);
    expect(spec.tabRail).toBe('compact');
    // The tabs are untouched, and no clock or other widget is added anywhere.
    expect(spec.tabs[0].sections[0].widgets).toHaveLength(1);
    expect(countWidgets(spec)).toBe(1);
  });

  it('does not migrate a spec that is already version 2', () => {
    const fresh = emptySpec('New');
    const { spec, migrated } = migrateSpec(JSON.parse(serialiseSpec(fresh)));
    expect(migrated).toBe(false);
    expect(spec.header).toEqual(fresh.header);
    expect(spec.tabRail).toBe('compact');
  });

  it('keeps a saved header and footer, and repairs bad values', () => {
    const { spec } = migrateSpec({
      version: 2,
      title: 'D',
      tabRail: 'wide',
      header: {
        sticky: true,
        show: 'kiosk',
        section: {
          id: 'anything',
          mode: 'self-scroll',
          title: 'Mine',
          widgets: [{ id: 'c', type: 'core.clock', x: 0, y: 0, w: 4, h: 2 }],
        },
      },
      footer: { sticky: 'yes', show: 'sometimes', section: 'nope' },
    });
    expect(spec.tabRail).toBe('wide');
    expect(spec.header.sticky).toBe(true);
    expect(spec.header.show).toBe('kiosk');
    // The band section always has its fixed id and the flow mode.
    expect(spec.header.section).toMatchObject({ id: '@header', mode: 'flow', title: 'Header' });
    expect(spec.header.section.widgets.map(w => w.id)).toEqual(['c']);
    expect(spec.footer.sticky).toBe(false);
    expect(spec.footer.show).toBe('both');
    expect(spec.footer.section.widgets).toEqual([]);
    expect(countWidgets(spec)).toBe(1);
  });

  it('does not let a tab section take a reserved id', () => {
    const { spec } = migrateSpec({
      version: 2,
      title: 'D',
      tabs: [{ id: 't', label: 'T', sections: [{ id: '@header', widgets: [] }] }],
    });
    expect(spec.tabs[0].sections[0].id).not.toBe('@header');
  });
});
