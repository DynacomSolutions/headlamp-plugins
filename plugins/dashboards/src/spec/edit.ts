/*
 * Pure edit operations on a DashboardSpec. Each returns a new spec and never mutates its input.
 * Unchanged tabs, sections and widgets keep their object identity, so memoised React
 * components skip work.
 */
import {
  Band,
  BandKey,
  bandKeyOf,
  BandShow,
  DashboardSpec,
  emptySection,
  emptyTab,
  GRID_COLUMNS,
  newId,
  Section,
  slugify,
  Tab,
  uniqueSlug,
  WidgetInstance,
} from './model';

export function moveItem<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || from >= list.length) return list;
  const target = Math.min(Math.max(to, 0), list.length - 1);
  const next = list.slice();
  const [item] = next.splice(from, 1);
  next.splice(target, 0, item);
  return next;
}

/** The header or the footer seen as a tab with one section, or undefined for a real tab id. */
const bandAsTab = (spec: DashboardSpec, tabId: string): { key: BandKey; tab: Tab } | undefined => {
  const key = bandKeyOf(tabId);
  return key
    ? { key, tab: { id: tabId, label: key, icon: '', sections: [spec[key].section] } }
    : undefined;
};

/** The sections of a tab, or the one section of the header or the footer. */
export const sectionsOf = (spec: DashboardSpec, tabId: string): Section[] =>
  bandAsTab(spec, tabId)?.tab.sections ?? spec.tabs.find(t => t.id === tabId)?.sections ?? [];

const mapTab = (spec: DashboardSpec, tabId: string, fn: (t: Tab) => Tab): DashboardSpec => {
  const band = bandAsTab(spec, tabId);
  if (band) {
    const n = fn(band.tab);
    const section = n.sections[0];
    if (n === band.tab || !section || section === spec[band.key].section) return spec;
    return { ...spec, [band.key]: { ...spec[band.key], section } };
  }
  let changed = false;
  const tabs = spec.tabs.map(t => {
    if (t.id !== tabId) return t;
    const n = fn(t);
    if (n !== t) changed = true;
    return n;
  });
  return changed ? { ...spec, tabs } : spec;
};

const mapSection = (
  spec: DashboardSpec,
  tabId: string,
  sectionId: string,
  fn: (s: Section) => Section
): DashboardSpec =>
  mapTab(spec, tabId, t => {
    let changed = false;
    const sections = t.sections.map(s => {
      if (s.id !== sectionId) return s;
      const n = fn(s);
      if (n !== s) changed = true;
      return n;
    });
    return changed ? { ...t, sections } : t;
  });

// ---- tabs ----

export function addTab(
  spec: DashboardSpec,
  label = 'New tab',
  icon = 'mdi:view-dashboard-outline'
): { spec: DashboardSpec; tabId: string } {
  const tab = emptyTab(
    label,
    icon,
    spec.tabs.map(t => t.id)
  );
  return { spec: { ...spec, tabs: [...spec.tabs, tab] }, tabId: tab.id };
}

export function updateTab(
  spec: DashboardSpec,
  tabId: string,
  patch: Partial<Pick<Tab, 'label' | 'icon' | 'fitHeight'>>
): DashboardSpec {
  return mapTab(spec, tabId, t => ({ ...t, ...patch }));
}

/** The last tab cannot be deleted: a dashboard always has one. */
export function deleteTab(spec: DashboardSpec, tabId: string): DashboardSpec {
  if (spec.tabs.length <= 1) return spec;
  return { ...spec, tabs: spec.tabs.filter(t => t.id !== tabId) };
}

export function reorderTabs(spec: DashboardSpec, from: number, to: number): DashboardSpec {
  const tabs = moveItem(spec.tabs, from, to);
  return tabs === spec.tabs ? spec : { ...spec, tabs };
}

// ---- header and footer ----

export function updateBand(
  spec: DashboardSpec,
  key: BandKey,
  patch: Partial<Pick<Band, 'sticky'>> & { show?: BandShow }
): DashboardSpec {
  const band = spec[key];
  const next = { ...band, ...patch };
  return next.sticky === band.sticky && next.show === band.show ? spec : { ...spec, [key]: next };
}

// ---- sections ----

export function addSection(spec: DashboardSpec, tabId: string, title = 'Section'): DashboardSpec {
  return mapTab(spec, tabId, t => ({ ...t, sections: [...t.sections, emptySection(title)] }));
}

export function updateSection(
  spec: DashboardSpec,
  tabId: string,
  sectionId: string,
  patch: Partial<Pick<Section, 'title' | 'showTitle' | 'mode' | 'height'>>
): DashboardSpec {
  return mapSection(spec, tabId, sectionId, s => ({ ...s, ...patch }));
}

/** A tab keeps at least one section. */
export function deleteSection(
  spec: DashboardSpec,
  tabId: string,
  sectionId: string
): DashboardSpec {
  return mapTab(spec, tabId, t =>
    t.sections.length <= 1 ? t : { ...t, sections: t.sections.filter(s => s.id !== sectionId) }
  );
}

export function reorderSections(
  spec: DashboardSpec,
  tabId: string,
  from: number,
  to: number
): DashboardSpec {
  return mapTab(spec, tabId, t => {
    const sections = moveItem(t.sections, from, to);
    return sections === t.sections ? t : { ...t, sections };
  });
}

// ---- widgets ----

/** The first free row under the lowest widget. */
export function nextRow(widgets: WidgetInstance[]): number {
  return widgets.reduce((m, w) => Math.max(m, w.y + w.h), 0);
}

export function newWidget(
  type: string,
  size: { w: number; h: number },
  config: Record<string, unknown>,
  at: { x: number; y: number }
): WidgetInstance {
  const w = Math.min(Math.max(1, size.w), GRID_COLUMNS);
  return {
    id: newId('w'),
    type,
    title: '',
    config,
    x: Math.min(at.x, GRID_COLUMNS - w),
    y: at.y,
    w,
    h: Math.max(1, size.h),
  };
}

export function addWidget(
  spec: DashboardSpec,
  tabId: string,
  sectionId: string,
  type: string,
  size: { w: number; h: number },
  config: Record<string, unknown>
): { spec: DashboardSpec; widgetId: string } {
  let widgetId = '';
  const next = mapSection(spec, tabId, sectionId, s => {
    const widget = newWidget(type, size, config, { x: 0, y: nextRow(s.widgets) });
    widgetId = widget.id;
    return { ...s, widgets: [...s.widgets, widget] };
  });
  return { spec: next, widgetId };
}

export function updateWidget(
  spec: DashboardSpec,
  tabId: string,
  sectionId: string,
  widgetId: string,
  patch: Partial<Pick<WidgetInstance, 'title' | 'config' | 'selfScroll'>>
): DashboardSpec {
  return mapSection(spec, tabId, sectionId, s => ({
    ...s,
    widgets: s.widgets.map(w => (w.id === widgetId ? { ...w, ...patch } : w)),
  }));
}

export function deleteWidget(
  spec: DashboardSpec,
  tabId: string,
  sectionId: string,
  widgetId: string
): DashboardSpec {
  return mapSection(spec, tabId, sectionId, s => ({
    ...s,
    widgets: s.widgets.filter(w => w.id !== widgetId),
  }));
}

/** The copy goes right under the original, with the same size. */
export function duplicateWidget(
  spec: DashboardSpec,
  tabId: string,
  sectionId: string,
  widgetId: string
): { spec: DashboardSpec; widgetId: string } {
  let copyId = '';
  const next = mapSection(spec, tabId, sectionId, s => {
    const src = s.widgets.find(w => w.id === widgetId);
    if (!src) return s;
    const copy: WidgetInstance = {
      ...src,
      id: newId('w'),
      config: JSON.parse(JSON.stringify(src.config)),
      y: src.y + src.h,
    };
    copyId = copy.id;
    return { ...s, widgets: [...s.widgets, copy] };
  });
  return { spec: next, widgetId: copyId };
}

/**
 * Move a widget to another section, landing at the bottom of it. Dragging between sections
 * uses this. The widget keeps its id, title and settings.
 */
export function moveWidgetToSection(
  spec: DashboardSpec,
  tabId: string,
  fromSectionId: string,
  toSectionId: string,
  widgetId: string
): DashboardSpec {
  if (fromSectionId === toSectionId) return spec;
  const sections = sectionsOf(spec, tabId);
  const widget = sections.find(s => s.id === fromSectionId)?.widgets.find(w => w.id === widgetId);
  const target = sections.find(s => s.id === toSectionId);
  if (!widget || !target) return spec;
  return mapTab(spec, tabId, t => ({
    ...t,
    sections: t.sections.map(s => {
      if (s.id === fromSectionId)
        return { ...s, widgets: s.widgets.filter(w => w.id !== widgetId) };
      if (s.id === toSectionId) {
        return { ...s, widgets: [...s.widgets, { ...widget, x: 0, y: nextRow(s.widgets) }] };
      }
      return s;
    }),
  }));
}

/** The widget could be moved between tabs too, for a section in another tab. */
export function moveWidgetToTabSection(
  spec: DashboardSpec,
  from: { tabId: string; sectionId: string },
  to: { tabId: string; sectionId: string },
  widgetId: string
): DashboardSpec {
  if (from.tabId === to.tabId)
    return moveWidgetToSection(spec, from.tabId, from.sectionId, to.sectionId, widgetId);
  const widget = sectionsOf(spec, from.tabId)
    .find(s => s.id === from.sectionId)
    ?.widgets.find(w => w.id === widgetId);
  if (!widget) return spec;
  const removed = deleteWidget(spec, from.tabId, from.sectionId, widgetId);
  return mapSection(removed, to.tabId, to.sectionId, s => ({
    ...s,
    widgets: [...s.widgets, { ...widget, x: 0, y: nextRow(s.widgets) }],
  }));
}

/** Replace one section's widget positions with the grid's result. Unchanged widgets keep identity. */
export function applyPositions(
  spec: DashboardSpec,
  tabId: string,
  sectionId: string,
  positions: ReadonlyArray<{ i: string; x: number; y: number; w: number; h: number }>
): DashboardSpec {
  const byId = new Map(positions.map(p => [p.i, p]));
  return mapSection(spec, tabId, sectionId, s => {
    let changed = false;
    const widgets = s.widgets.map(w => {
      const p = byId.get(w.id);
      if (!p || (p.x === w.x && p.y === w.y && p.w === w.w && p.h === w.h)) return w;
      changed = true;
      return { ...w, x: p.x, y: p.y, w: p.w, h: p.h };
    });
    return changed ? { ...s, widgets } : s;
  });
}

// ---- saved views ----

export function saveView(
  spec: DashboardSpec,
  name: string,
  filters: DashboardSpec['filters']
): DashboardSpec {
  const existing = spec.views.find(v => v.name === name);
  if (existing) {
    return { ...spec, views: spec.views.map(v => (v === existing ? { ...v, filters } : v)) };
  }
  const id = uniqueSlug(
    slugify(name, 'view'),
    spec.views.map(v => v.id)
  );
  return { ...spec, views: [...spec.views, { id, name, filters }] };
}

export function deleteView(spec: DashboardSpec, viewId: string): DashboardSpec {
  return { ...spec, views: spec.views.filter(v => v.id !== viewId) };
}

/** A copy of a spec for "Duplicate dashboard": new title, same content. */
export function cloneSpec(spec: DashboardSpec, title: string): DashboardSpec {
  const copy: DashboardSpec = JSON.parse(JSON.stringify(spec));
  copy.title = title;
  delete copy.modifiedAt;
  return copy;
}
