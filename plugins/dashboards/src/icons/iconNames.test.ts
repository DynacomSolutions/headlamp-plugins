import { describe, expect, it } from 'vitest';
import { ICON_NAMES, isBundledIcon, isIconName, searchIcons } from './iconNames';

describe('icon search', () => {
  it('lists mdi names', () => {
    expect(ICON_NAMES.length).toBeGreaterThan(800);
    expect(ICON_NAMES.every(n => n.startsWith('mdi:'))).toBe(true);
  });
  it('requires every word', () => {
    const r = searchIcons('clock outline');
    expect(r).toContain('mdi:clock-outline');
    expect(r.every(n => n.includes('clock') && n.includes('outline'))).toBe(true);
    expect(searchIcons('zzzzzz')).toEqual([]);
    expect(searchIcons('')).toHaveLength(120);
    expect(searchIcons('mdi:server')).toContain('mdi:server');
  });
  it('bundles the common operations icons', () => {
    for (const n of [
      'run-fast',
      'alert-decagram-outline',
      'speedometer',
      'alert-circle-outline',
      'database',
      'console',
      'github',
      'server',
      'kubernetes',
      'chart-line',
      'clock-outline',
      'robot',
    ])
      expect(isBundledIcon(`mdi:${n}`), n).toBe(true);
    expect(searchIcons('run fast')).toContain('mdi:run-fast');
  });
  it('validates names', () => {
    expect(isIconName('mdi:chart-line')).toBe(true);
    expect(isIconName('chart-line')).toBe(false);
    expect(isIconName('mdi:Bad Name')).toBe(false);
  });
  it('knows which icons are bundled', () => {
    expect(isBundledIcon('mdi:server')).toBe(true);
    expect(isBundledIcon('mdi:not-a-bundled-icon')).toBe(false);
    expect(isBundledIcon('mdi:constructor')).toBe(false);
    expect(isBundledIcon('server')).toBe(false);
    expect(isBundledIcon(undefined)).toBe(false);
  });
});
