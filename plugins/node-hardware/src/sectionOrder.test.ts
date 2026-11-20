import { describe, expect, it } from 'vitest';
import { moveHardwareProfileSection } from './sectionOrder';

const ids = (l: { id: string }[]) => l.map(s => s.id);
const mk = (...i: string[]) => i.map(id => ({ id }));

describe('moveHardwareProfileSection', () => {
  const base = mk('BACK_LINK', 'MAIN_HEADER', 'METADATA', 'headlamp.node-resource-allocation', 'headlamp.node-owned-pods', 'node-hardware.profile', 'node-hardware.sensors', 'EVENTS');

  it('moves the profile directly before the pods section', () => {
    expect(ids(moveHardwareProfileSection('Node', base))).toEqual([
      'BACK_LINK', 'MAIN_HEADER', 'METADATA', 'headlamp.node-resource-allocation', 'node-hardware.profile', 'headlamp.node-owned-pods', 'node-hardware.sensors', 'EVENTS',
    ]);
  });
  it('keeps every other section in order and does not mutate the input', () => {
    const copy = [...base];
    const out = moveHardwareProfileSection('Node', base);
    expect(base).toEqual(copy);
    expect(ids(out.filter(s => s.id !== 'node-hardware.profile'))).toEqual(ids(base.filter(s => s.id !== 'node-hardware.profile')));
  });
  it('is idempotent', () => {
    const once = moveHardwareProfileSection('Node', base);
    expect(moveHardwareProfileSection('Node', once)).toBe(once);
  });
  it('ignores other kinds', () => {
    expect(moveHardwareProfileSection('Pod', base)).toBe(base);
    expect(moveHardwareProfileSection(undefined, base)).toBe(base);
  });
  it('falls back to after the main info section when the pods id is missing', () => {
    const l = mk('MAIN_HEADER', 'METADATA', 'headlamp.node-conditions', 'node-hardware.profile', 'EVENTS');
    expect(ids(moveHardwareProfileSection('Node', l))).toEqual(['MAIN_HEADER', 'METADATA', 'node-hardware.profile', 'headlamp.node-conditions', 'EVENTS']);
  });
  it('returns the list unchanged when both the pods and main info ids are missing', () => {
    const l = mk('MAIN_HEADER', 'node-hardware.profile');
    expect(moveHardwareProfileSection('Node', l)).toBe(l);
  });
  it('returns the list unchanged when the profile id is missing', () => {
    const l = mk('MAIN_HEADER', 'METADATA');
    expect(moveHardwareProfileSection('Node', l)).toBe(l);
  });
  it('tolerates non-object entries', () => {
    const l: unknown[] = ['text', null, { id: 'METADATA' }, { id: 'node-hardware.profile' }];
    expect(moveHardwareProfileSection('Node', l)).toBe(l);
  });
});
