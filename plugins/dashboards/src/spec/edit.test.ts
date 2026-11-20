import { describe, expect, it } from 'vitest';
import {
  addSection,
  addTab,
  addWidget,
  applyPositions,
  cloneSpec,
  deleteSection,
  deleteTab,
  deleteView,
  deleteWidget,
  duplicateWidget,
  moveItem,
  moveWidgetToSection,
  moveWidgetToTabSection,
  reorderSections,
  reorderTabs,
  saveView,
  updateWidget,
} from './edit';
import { defaultFilters, emptySpec } from './model';

const base = () => {
  let spec = emptySpec('Ops');
  const tabId = spec.tabs[0].id;
  spec = addSection(spec, tabId, 'Second');
  const [s1, s2] = spec.tabs[0].sections;
  const a = addWidget(spec, tabId, s1.id, 'core.clock', { w: 3, h: 4 }, { x: 1 });
  const b = addWidget(a.spec, tabId, s1.id, 'core.note', { w: 4, h: 2 }, {});
  return { spec: b.spec, tabId, s1: s1.id, s2: s2.id, w1: a.widgetId, w2: b.widgetId };
};

describe('moveItem', () => {
  it('moves and clamps', () => {
    expect(moveItem([1, 2, 3], 0, 2)).toEqual([2, 3, 1]);
    expect(moveItem([1, 2, 3], 2, 99)).toEqual([1, 2, 3]);
    const same = [1, 2, 3];
    expect(moveItem(same, 1, 1)).toBe(same);
  });
});

describe('tabs', () => {
  it('adds, reorders and deletes, keeping one tab', () => {
    const { spec, tabId } = base();
    const added = addTab(spec, 'Nodes');
    expect(added.spec.tabs).toHaveLength(2);
    expect(reorderTabs(added.spec, 1, 0).tabs[0].id).toBe(added.tabId);
    expect(deleteTab(added.spec, added.tabId).tabs).toHaveLength(1);
    expect(deleteTab(spec, tabId)).toBe(spec);
  });
});

describe('sections and widgets', () => {
  it('stacks new widgets under the lowest one', () => {
    const { spec, s1 } = base();
    const ws = spec.tabs[0].sections.find(s => s.id === s1)!.widgets;
    expect(ws[0].y).toBe(0);
    expect(ws[1].y).toBe(4);
  });

  it('keeps a section and the identity of untouched ones', () => {
    const { spec, tabId, s1, s2 } = base();
    const before = spec.tabs[0].sections.find(s => s.id === s2)!;
    const next = deleteWidget(spec, tabId, s1, spec.tabs[0].sections[0].widgets[0].id);
    expect(next.tabs[0].sections.find(s => s.id === s2)).toBe(before);
    expect(reorderSections(spec, tabId, 0, 1).tabs[0].sections[0].id).toBe(s2);
    const one = deleteSection(deleteSection(spec, tabId, s2), tabId, s1);
    expect(one.tabs[0].sections).toHaveLength(1);
  });

  it('duplicates a widget with a deep copy of its config', () => {
    const { spec, tabId, s1, w1 } = base();
    const { spec: next, widgetId } = duplicateWidget(spec, tabId, s1, w1);
    const ws = next.tabs[0].sections[0].widgets;
    const [orig, copy] = [ws.find(w => w.id === w1)!, ws.find(w => w.id === widgetId)!];
    expect(copy.config).toEqual(orig.config);
    expect(copy.config).not.toBe(orig.config);
    expect(copy.id).not.toBe(orig.id);
  });

  it('moves a widget between sections and between tabs', () => {
    const { spec, tabId, s1, s2, w1 } = base();
    const moved = moveWidgetToSection(spec, tabId, s1, s2, w1);
    expect(moved.tabs[0].sections[0].widgets.some(w => w.id === w1)).toBe(false);
    expect(moved.tabs[0].sections[1].widgets.map(w => w.id)).toEqual([w1]);
    expect(moveWidgetToSection(spec, tabId, s1, s1, w1)).toBe(spec);

    const two = addTab(spec, 'Other');
    const target = two.spec.tabs[1].sections[0].id;
    const across = moveWidgetToTabSection(two.spec, { tabId, sectionId: s1 }, { tabId: two.tabId, sectionId: target }, w1);
    expect(across.tabs[1].sections[0].widgets.map(w => w.id)).toEqual([w1]);
    expect(across.tabs[0].sections[0].widgets.some(w => w.id === w1)).toBe(false);
  });

  it('applies grid positions and keeps unchanged widgets by identity', () => {
    const { spec, tabId, s1, w1, w2 } = base();
    const [a, b] = spec.tabs[0].sections[0].widgets;
    const next = applyPositions(spec, tabId, s1, [
      { i: w1, x: 5, y: 0, w: 3, h: 4 },
      { i: w2, x: b.x, y: b.y, w: b.w, h: b.h },
    ]);
    const [a2, b2] = next.tabs[0].sections[0].widgets;
    expect(a2.x).toBe(5);
    expect(a2).not.toBe(a);
    expect(b2).toBe(b);
    // Same positions: the whole spec is returned unchanged.
    expect(applyPositions(next, tabId, s1, [{ i: w1, x: 5, y: 0, w: 3, h: 4 }])).toBe(next);
  });

  it('keeps config identity when only the position changes', () => {
    const { spec, tabId, s1, w1 } = base();
    const before = spec.tabs[0].sections[0].widgets[0].config;
    const next = applyPositions(spec, tabId, s1, [{ i: w1, x: 9, y: 3, w: 3, h: 4 }]);
    expect(next.tabs[0].sections[0].widgets[0].config).toBe(before);
  });

  it('updates a widget', () => {
    const { spec, tabId, s1, w1 } = base();
    const next = updateWidget(spec, tabId, s1, w1, { title: 'Hello', selfScroll: true });
    expect(next.tabs[0].sections[0].widgets[0]).toMatchObject({ title: 'Hello', selfScroll: true });
  });
});

describe('views and clone', () => {
  it('saves, replaces and deletes a view', () => {
    const f = { ...defaultFilters(), namespaces: ['a'] };
    let spec = saveView(emptySpec('x'), 'Team A', f);
    expect(spec.views).toHaveLength(1);
    spec = saveView(spec, 'Team A', { ...f, namespaces: ['b'] });
    expect(spec.views).toHaveLength(1);
    expect(spec.views[0].filters.namespaces).toEqual(['b']);
    spec = saveView(spec, 'Team A 2', f);
    expect(new Set(spec.views.map(v => v.id)).size).toBe(2);
    expect(deleteView(spec, spec.views[0].id).views).toHaveLength(1);
  });

  it('clones with a new title and no shared objects', () => {
    const { spec } = base();
    const c = cloneSpec({ ...spec, modifiedAt: 'x' }, 'Copy');
    expect(c.title).toBe('Copy');
    expect(c.modifiedAt).toBeUndefined();
    expect(c.tabs).not.toBe(spec.tabs);
    expect(c.tabs[0].sections[0].widgets[0].config).toEqual(spec.tabs[0].sections[0].widgets[0].config);
  });
});
