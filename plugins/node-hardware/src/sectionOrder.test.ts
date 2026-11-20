import { describe, expect, it } from 'vitest';
import { moveHardwareProfileSection } from './sectionOrder';

/*
 * Faithful copy of Headlamp v0.44.0 reducer logic from
 * frontend/src/components/DetailsViewSection/detailsViewSectionSlice.ts
 * (setDetailsViewSection, lines 124-139, and _normalizeProcessor, lines 65-85).
 * The strict-mode module makes assignment to a frozen property throw, like the browser bundle.
 */
function setDetailsViewSection(state: { sections: any[] }, payload: any) {
  let section = payload;
  if (section.id === undefined) {
    if (section.section === undefined) {
      section = { id: '', section: section };
    } else {
      section = { id: '', section: section.section };
    }
  }
  section.id = section.id || `generated-id-${Date.now().toString(36)}`;
  state.sections.push(section);
}
function normalizeProcessor(payload: any) {
  let p = payload;
  if (p.id === undefined && typeof p === 'function') {
    p = { id: '', processor: p };
  }
  p.id = p.id || `generated-id-${Date.now().toString(36)}`;
  return p;
}

const ids = (l: { id: string }[]) => l.map(s => s.id);
const mk = (...i: string[]) => i.map(id => ({ id }));

describe('registration against the Headlamp reducer with frozen input', () => {
  it('the object form throws on a frozen object (the v0.38.1 failure)', () => {
    expect(() => setDetailsViewSection({ sections: [] }, Object.freeze({ id: 'x', section: () => null }))).toThrow(
      /read only property 'id'/
    );
  });

  it('the function form works with a frozen function and keeps the function identity', () => {
    const profile = Object.freeze(() => null);
    const state = { sections: [] as any[] };
    expect(() => setDetailsViewSection(state, profile)).not.toThrow();
    expect(state.sections[0].section).toBe(profile);
  });

  it('the function processor works with a frozen function', () => {
    const fn = Object.freeze((_r: any, s: any[]) => s);
    expect(() => normalizeProcessor(fn)).not.toThrow();
    expect(normalizeProcessor(fn).processor).toBe(fn);
  });

  it('orders the wrapped sections by function identity', () => {
    const profile = Object.freeze(() => null);
    const sensors = Object.freeze(() => null);
    const state = { sections: [] as any[] };
    setDetailsViewSection(state, profile);
    setDetailsViewSection(state, sensors);
    // Both generated ids can be equal when registered in the same millisecond.
    const all = [...mk('BACK_LINK', 'MAIN_HEADER', 'METADATA', 'headlamp.node-owned-pods'), ...state.sections, ...mk('EVENTS')];
    const out = moveHardwareProfileSection('Node', all, profile);
    expect(out.indexOf(state.sections[0])).toBe(3);
    expect(out[4]).toEqual({ id: 'headlamp.node-owned-pods' });
    expect(out.indexOf(state.sections[1])).toBe(5);
  });
});

describe('moveHardwareProfileSection', () => {
  const profile = () => null;
  const p = { id: 'generated-id-a', section: profile };
  const base: any[] = [
    ...mk('BACK_LINK', 'MAIN_HEADER', 'METADATA', 'headlamp.node-resource-allocation', 'headlamp.node-owned-pods'),
    p,
    { id: 'generated-id-a', section: () => null },
    ...mk('EVENTS'),
  ];

  it('moves the profile directly before the pods section', () => {
    const out = moveHardwareProfileSection('Node', base, profile);
    expect(ids(out)).toEqual([
      'BACK_LINK', 'MAIN_HEADER', 'METADATA', 'headlamp.node-resource-allocation', 'generated-id-a', 'headlamp.node-owned-pods', 'generated-id-a', 'EVENTS',
    ]);
    expect(out[4]).toBe(p);
  });
  it('does not mutate the input, even when frozen', () => {
    const frozen = Object.freeze(base.map(s => Object.freeze({ ...s }))) as any[];
    const copy = [...frozen];
    const out = moveHardwareProfileSection('Node', frozen, frozen[5].section);
    expect(frozen).toEqual(copy);
    expect(out).toHaveLength(frozen.length);
  });
  it('is idempotent', () => {
    const once = moveHardwareProfileSection('Node', base, profile);
    expect(moveHardwareProfileSection('Node', once, profile)).toBe(once);
  });
  it('ignores other kinds', () => {
    expect(moveHardwareProfileSection('Pod', base, profile)).toBe(base);
    expect(moveHardwareProfileSection(undefined, base, profile)).toBe(base);
  });
  it('falls back to after the main info section when the pods id is missing', () => {
    const l: any[] = [...mk('MAIN_HEADER', 'METADATA', 'headlamp.node-conditions'), p, ...mk('EVENTS')];
    expect(ids(moveHardwareProfileSection('Node', l, profile))).toEqual(['MAIN_HEADER', 'METADATA', 'generated-id-a', 'headlamp.node-conditions', 'EVENTS']);
  });
  it('returns the list unchanged when both anchors are missing', () => {
    const l: any[] = [...mk('MAIN_HEADER'), p];
    expect(moveHardwareProfileSection('Node', l, profile)).toBe(l);
  });
  it('returns the list unchanged when the profile section is missing', () => {
    const l = mk('MAIN_HEADER', 'METADATA');
    expect(moveHardwareProfileSection('Node', l, profile)).toBe(l);
  });
  it('tolerates non-object entries', () => {
    const l: unknown[] = ['text', null, { id: 'METADATA' }, p];
    const out = moveHardwareProfileSection('Node', l, profile);
    expect(out).toHaveLength(4);
    expect(out.indexOf(p)).toBe(2);
  });
});
