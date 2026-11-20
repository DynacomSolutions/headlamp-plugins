/*
 * The dashboard spec: the JSON saved in one ConfigMap per dashboard. It has a `version` field
 * and `migrateSpec` upgrades older versions step by step. Everything read from a ConfigMap
 * goes through `migrateSpec`, which also fills defaults and drops invalid parts, so the rest
 * of the plugin can trust the shape.
 */
import type { DashboardFilters, TimeRange } from '../contract';
import { isBundledIcon } from '../icons/iconNames';

export const SPEC_VERSION = 2;

export const TIME_RANGES: ReadonlyArray<TimeRange> = ['5m', '15m', '1h', '6h', '24h', '7d', '30d'];
export const DEFAULT_RANGE: TimeRange = '1h';

export const GRID_COLUMNS = 12;
export const DEFAULT_SECTION_HEIGHT = 400;
export const MIN_SECTION_HEIGHT = 120;
export const MAX_SECTION_HEIGHT = 4000;

export type TabPosition = 'top' | 'left';
/** How the tabs look when they sit on the left: a narrow rail of icons with labels, or wide tabs. */
export type TabRail = 'compact' | 'wide';
export const TAB_RAILS: ReadonlyArray<TabRail> = ['compact', 'wide'];
/** Where a header or footer shows: in the normal view, in the kiosk, or in both. */
export type BandShow = 'both' | 'normal' | 'kiosk';
export const BAND_SHOWS: ReadonlyArray<BandShow> = ['both', 'normal', 'kiosk'];
/**
 * The header and the footer are not tabs, but the edit operations treat each as a tab with one
 * section. Their ids start with `@`, which a generated id never does.
 */
export const HEADER_ID = '@header';
export const FOOTER_ID = '@footer';
export type BandKey = 'header' | 'footer';
export const isBandId = (id: string): id is typeof HEADER_ID | typeof FOOTER_ID =>
  id === HEADER_ID || id === FOOTER_ID;
export const bandKeyOf = (id: string): BandKey | null =>
  id === HEADER_ID ? 'header' : id === FOOTER_ID ? 'footer' : null;
export type SectionMode = 'flow' | 'sticky-top' | 'sticky-bottom' | 'self-scroll';
export const SECTION_MODES: ReadonlyArray<SectionMode> = [
  'flow',
  'sticky-top',
  'sticky-bottom',
  'self-scroll',
];

/** Automatic refresh intervals in seconds. 0 is off. */
export const REFRESH_OPTIONS: ReadonlyArray<{ seconds: number; label: string }> = [
  { seconds: 0, label: 'Off' },
  { seconds: 10, label: '10 s' },
  { seconds: 30, label: '30 s' },
  { seconds: 60, label: '1 min' },
  { seconds: 300, label: '5 min' },
  { seconds: 900, label: '15 min' },
];

export interface WidgetInstance {
  id: string;
  /** The widget type id from the registry. May be unknown when its plugin is not installed. */
  type: string;
  /** A user title. Empty means the widget type's title. */
  title: string;
  config: Record<string, unknown>;
  /** Overrides the widget type's self-scroll default. */
  selfScroll?: boolean;
  /** Grid position and size. */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Section {
  id: string;
  title: string;
  showTitle: boolean;
  mode: SectionMode;
  /** Height in px of a self-scroll section. */
  height: number;
  widgets: WidgetInstance[];
}

/** The dashboard header or footer: one section of widgets shown with every tab. */
export interface Band {
  /** The header sticks to the top and the footer to the bottom of the view. */
  sticky: boolean;
  show: BandShow;
  /** Its id is `@header` or `@footer`. It has its own grid of widgets, like any section. */
  section: Section;
}

export interface Tab {
  id: string;
  label: string;
  /** An Iconify name, `mdi:` for the picker. */
  icon: string;
  sections: Section[];
}

export interface SavedView {
  id: string;
  name: string;
  filters: DashboardFilters;
}

export interface DashboardSpec {
  version: number;
  title: string;
  description: string;
  tabPosition: TabPosition;
  /** The look of the tabs on the left. Top tabs ignore it. */
  tabRail: TabRail;
  /** Shown above the tab content on every tab. Empty (no widgets) draws nothing. */
  header: Band;
  /** Shown below the tab content on every tab. */
  footer: Band;
  /** Automatic refresh in seconds, 0 for off. */
  refreshSeconds: number;
  /** Show the filter bar in kiosk mode. Off by default: a wall screen needs no filters. */
  kioskShowFilters: boolean;
  /** The filter values of a plain open (no saved view, no URL filters). */
  filters: DashboardFilters;
  tabs: Tab[];
  views: SavedView[];
  /** ISO time of the last save made by the UI. */
  modifiedAt?: string;
}

export class SpecError extends Error {}
/** The spec was saved by a newer version of the plugin. It is shown read-only. */
export class SpecVersionError extends SpecError {}

export const defaultFilters = (): DashboardFilters => ({
  namespaces: [],
  nodes: [],
  labelSelector: '',
  range: DEFAULT_RANGE,
});

export const sameFilters = (a: DashboardFilters, b: DashboardFilters): boolean =>
  a.range === b.range &&
  a.labelSelector === b.labelSelector &&
  a.namespaces.length === b.namespaces.length &&
  a.namespaces.every((v, i) => v === b.namespaces[i]) &&
  a.nodes.length === b.nodes.length &&
  a.nodes.every((v, i) => v === b.nodes[i]);

let counter = 0;
/** A short random id, for tabs, sections, widgets and views. Unique within one dashboard. */
export function newId(prefix: string): string {
  counter += 1;
  const rand = Math.random().toString(36).slice(2, 7);
  return `${prefix}-${rand}${counter.toString(36)}`;
}

/** Lower case, DNS-1123 label: letters, digits and single dashes, at most 63 characters. */
export function slugify(text: string, fallback = 'dashboard'): string {
  const s = text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/g, '');
  return s || fallback;
}

/** `base`, or `base-2`, `base-3`, and so on, the first not in `taken`. */
export function uniqueSlug(base: string, taken: Iterable<string>): string {
  const set = new Set(taken);
  if (!set.has(base)) return base;
  for (let i = 2; ; i += 1) {
    const suffix = `-${i}`;
    const candidate = `${base.slice(0, 63 - suffix.length).replace(/-+$/g, '')}${suffix}`;
    if (!set.has(candidate)) return candidate;
  }
}

export function emptySection(title = 'Section'): Section {
  return {
    id: newId('sec'),
    title,
    showTitle: false,
    mode: 'flow',
    height: DEFAULT_SECTION_HEIGHT,
    widgets: [],
  };
}

export function emptyBand(key: BandKey): Band {
  return {
    sticky: false,
    show: 'both',
    section: {
      id: key === 'header' ? HEADER_ID : FOOTER_ID,
      title: key === 'header' ? 'Header' : 'Footer',
      showTitle: false,
      mode: 'flow',
      height: DEFAULT_SECTION_HEIGHT,
      widgets: [],
    },
  };
}

export const DEFAULT_TAB_ICON = 'mdi:view-dashboard-outline';

export function emptyTab(label = 'Overview', icon = DEFAULT_TAB_ICON, taken: string[] = []): Tab {
  return {
    id: uniqueSlug(slugify(label, 'tab'), taken),
    label,
    icon,
    sections: [emptySection('Main')],
  };
}

export function emptySpec(title: string): DashboardSpec {
  return {
    version: SPEC_VERSION,
    title,
    description: '',
    tabPosition: 'top',
    tabRail: 'compact',
    header: emptyBand('header'),
    footer: emptyBand('footer'),
    refreshSeconds: 0,
    kioskShowFilters: false,
    filters: defaultFilters(),
    tabs: [emptyTab()],
    views: [],
  };
}

// ---- migration ----

type Raw = Record<string, any>;

/**
 * One step per version: `MIGRATIONS[n]` turns a version `n` spec into version `n + 1`. Add the
 * step here and raise SPEC_VERSION when the shape changes.
 * - 1 to 2: adds an empty `header` and `footer` and `tabRail: 'compact'`. Nothing else changes,
 *   so an old dashboard looks the same, except that its left tab bar becomes the compact rail.
 */
export const MIGRATIONS: Record<number, (raw: Raw) => Raw> = {
  1: raw => ({
    ...raw,
    header: emptyBand('header'),
    footer: emptyBand('footer'),
    tabRail: 'compact',
  }),
};

const isObject = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const strList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : [];
const num = (v: unknown, fallback: number, min: number, max: number): number =>
  typeof v === 'number' && Number.isFinite(v)
    ? Math.min(max, Math.max(min, Math.round(v)))
    : fallback;

export function normaliseFilters(raw: unknown): DashboardFilters {
  const r = isObject(raw) ? raw : {};
  return {
    namespaces: strList(r.namespaces),
    nodes: strList(r.nodes),
    labelSelector: str(r.labelSelector),
    range: (TIME_RANGES as ReadonlyArray<string>).includes(r.range)
      ? (r.range as TimeRange)
      : DEFAULT_RANGE,
  };
}

function uniqueIds<T extends { id: string }>(items: T[], prefix: string): T[] {
  const seen = new Set<string>();
  return items.map(item => {
    let id = item.id;
    while (seen.has(id)) id = newId(prefix);
    seen.add(id);
    return id === item.id ? item : { ...item, id };
  });
}

/**
 * The palette lists one entry per panel source, as the type `agent.panel.<source id>` or
 * `agent.sunburst.<source id>`. Sources are settings of one browser, so a spec never holds these
 * types: it holds the base type with `config.source`. Earlier versions did save them.
 */
export function baseWidgetType(type: string): { type: string; source: string } | null {
  const m = /^(agent\.(?:panel|sunburst))\.([a-z0-9][a-z0-9_-]{0,39})$/.exec(type);
  return m ? { type: m[1], source: m[2] } : null;
}

function normaliseWidget(raw: unknown): WidgetInstance | null {
  if (!isObject(raw) || typeof raw.type !== 'string' || raw.type === '') return null;
  let type = raw.type;
  let config: Raw = isObject(raw.config) ? raw.config : {};
  const legacy = baseWidgetType(type);
  if (legacy) {
    // Keep the source the widget showed: a saved `source` wins over the one in the type.
    type = legacy.type;
    if (typeof config.source !== 'string' || config.source === '')
      config = { ...config, source: legacy.source };
  }
  const w: WidgetInstance = {
    id: str(raw.id) || newId('w'),
    type,
    title: str(raw.title),
    config,
    x: num(raw.x, 0, 0, GRID_COLUMNS - 1),
    y: num(raw.y, 0, 0, 100000),
    w: num(raw.w, 4, 1, GRID_COLUMNS),
    h: num(raw.h, 4, 1, 1000),
  };
  if (typeof raw.selfScroll === 'boolean') w.selfScroll = raw.selfScroll;
  w.x = Math.min(w.x, GRID_COLUMNS - w.w);
  return w;
}

function normaliseSection(raw: unknown): Section | null {
  if (!isObject(raw)) return null;
  const widgets = uniqueIds(
    (Array.isArray(raw.widgets) ? raw.widgets : [])
      .map(normaliseWidget)
      .filter((w): w is WidgetInstance => w !== null),
    'w'
  );
  return {
    // An id that starts with `@` is reserved for the header and the footer.
    id: (str(raw.id).startsWith('@') ? '' : str(raw.id)) || newId('sec'),
    title: str(raw.title, 'Section'),
    showTitle: raw.showTitle === true,
    mode: (SECTION_MODES as ReadonlyArray<string>).includes(raw.mode) ? raw.mode : 'flow',
    height: num(raw.height, DEFAULT_SECTION_HEIGHT, MIN_SECTION_HEIGHT, MAX_SECTION_HEIGHT),
    widgets,
  };
}

function normaliseBand(raw: unknown, key: BandKey): Band {
  const empty = emptyBand(key);
  if (!isObject(raw)) return empty;
  const section = normaliseSection({ ...(isObject(raw.section) ? raw.section : {}) });
  return {
    sticky: raw.sticky === true,
    show: (BAND_SHOWS as ReadonlyArray<string>).includes(raw.show) ? raw.show : 'both',
    // The band is one flow section with a fixed id, so the edit operations find it.
    section: {
      ...(section ?? empty.section),
      id: empty.section.id,
      title: empty.section.title,
      showTitle: false,
      mode: 'flow',
    },
  };
}

function normaliseTab(raw: unknown, taken: string[]): Tab | null {
  if (!isObject(raw)) return null;
  const sections = uniqueIds(
    (Array.isArray(raw.sections) ? raw.sections : [])
      .map(x => normaliseSection(x))
      .filter((s): s is Section => s !== null),
    'sec'
  );
  const label = str(raw.label, 'Tab');
  return {
    id: str(raw.id) || uniqueSlug(slugify(label, 'tab'), taken),
    label,
    // A name that is not bundled would make the browser ask the public Iconify service.
    icon: isBundledIcon(raw.icon) ? raw.icon : DEFAULT_TAB_ICON,
    sections: sections.length > 0 ? sections : [emptySection('Main')],
  };
}

/**
 * Upgrade a parsed spec to the current version and fill every default. Throws `SpecError`
 * for something that is not a spec and `SpecVersionError` for a version newer than this one.
 */
export function migrateSpec(input: unknown): { spec: DashboardSpec; migrated: boolean } {
  if (!isObject(input)) throw new SpecError('The dashboard data is not a JSON object.');
  let raw: Raw = input;
  const from = typeof raw.version === 'number' ? raw.version : 1;
  if (from > SPEC_VERSION) {
    throw new SpecVersionError(
      `This dashboard uses spec version ${from}, but this plugin supports up to version ${SPEC_VERSION}. Update the plugin to edit it.`
    );
  }
  for (let v = from; v < SPEC_VERSION; v += 1) {
    const step = MIGRATIONS[v];
    if (!step) throw new SpecError(`No migration from spec version ${v}.`);
    raw = { ...step(raw), version: v + 1 };
  }
  const tabs: Tab[] = [];
  for (const t of Array.isArray(raw.tabs) ? raw.tabs : []) {
    const tab = normaliseTab(
      t,
      tabs.map(x => x.id)
    );
    if (tab) {
      // Tab ids appear in URLs, so a duplicate gets a new one.
      const id = tabs.some(x => x.id === tab.id)
        ? uniqueSlug(
            tab.id,
            tabs.map(x => x.id)
          )
        : tab.id;
      tabs.push(id === tab.id ? tab : { ...tab, id });
    }
  }
  const views = uniqueIds(
    (Array.isArray(raw.views) ? raw.views : []).filter(isObject).map(v => ({
      id: str(v.id) || newId('view'),
      name: str(v.name, 'View'),
      filters: normaliseFilters(v.filters),
    })),
    'view'
  );
  const spec: DashboardSpec = {
    version: SPEC_VERSION,
    title: str(raw.title, 'Dashboard'),
    description: str(raw.description),
    tabPosition: raw.tabPosition === 'left' ? 'left' : 'top',
    tabRail: raw.tabRail === 'wide' ? 'wide' : 'compact',
    header: normaliseBand(raw.header, 'header'),
    footer: normaliseBand(raw.footer, 'footer'),
    refreshSeconds: REFRESH_OPTIONS.some(o => o.seconds === raw.refreshSeconds)
      ? raw.refreshSeconds
      : 0,
    kioskShowFilters: raw.kioskShowFilters === true,
    filters: normaliseFilters(raw.filters),
    tabs: tabs.length > 0 ? tabs : [emptyTab()],
    views,
  };
  if (typeof raw.modifiedAt === 'string') spec.modifiedAt = raw.modifiedAt;
  return { spec, migrated: from < SPEC_VERSION };
}

export function parseSpec(text: string): { spec: DashboardSpec; migrated: boolean } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new SpecError('The dashboard data is not valid JSON.');
  }
  return migrateSpec(data);
}

export function serialiseSpec(spec: DashboardSpec): string {
  return JSON.stringify({ ...spec, version: SPEC_VERSION });
}

export function countWidgets(spec: DashboardSpec): number {
  return (
    spec.tabs.reduce((n, t) => n + t.sections.reduce((m, s) => m + s.widgets.length, 0), 0) +
    spec.header.section.widgets.length +
    spec.footer.section.widgets.length
  );
}
