import { describe, expect, it } from 'vitest';
import { CPU_LAYOUT, GPU_LAYOUT, gridColumns, MEMORY_LAYOUT, NVME_LAYOUT, PCI_LAYOUT, SLOTS_LAYOUT, tableSx, wrapSelector } from './tableLayout';

describe('hardware table layout', () => {
  it('lets the Link column wrap in every table that has one, so the amber mark stays in view', () => {
    expect(SLOTS_LAYOUT.wrap).toContain(8);
    expect(PCI_LAYOUT.wrap).toContain(6);
    expect(GPU_LAYOUT.wrap).toContain(7);
    expect(NVME_LAYOUT.wrap).toContain(6);
  });

  it('keeps slot, lanes, generation and status cells on one line', () => {
    for (const n of [1, 2, 4, 5, 6]) {
      expect(SLOTS_LAYOUT.wrap).not.toContain(n);
    }
  });

  it('builds a selector for the wrapping body cells only', () => {
    expect(wrapSelector({ columns: 6, wrap: [2, 6] })).toBe('& td:nth-of-type(2), & td:nth-of-type(6)');
  });

  it('sizes short columns to their content and shares the rest between the wrapping columns', () => {
    expect(gridColumns({ columns: 4, wrap: [2, 4] })).toBe(
      'max-content minmax(6ch, 1fr) max-content minmax(6ch, 1fr)',
    );
    for (const l of [CPU_LAYOUT, MEMORY_LAYOUT, SLOTS_LAYOUT, PCI_LAYOUT, GPU_LAYOUT, NVME_LAYOUT]) {
      expect(gridColumns(l).match(/max-content|minmax\(/g)).toHaveLength(l.columns);
      expect(Math.max(...l.wrap)).toBeLessThanOrEqual(l.columns);
    }
  });

  it('scrolls inside the box and never sets a minimum table width', () => {
    const sx = tableSx(SLOTS_LAYOUT) as Record<string, Record<string, unknown>>;
    expect(sx.overflowX).toBe('auto');
    expect(sx['& table'].width).toBe('100%');
    expect(sx['& table'].gridTemplateColumns).toBe(gridColumns(SLOTS_LAYOUT));
    expect(sx['& table'].minWidth).toBeUndefined();
    expect(sx['& td'].whiteSpace).toBe('nowrap');
    expect(sx['&& th, && td'].padding).toBe('6px 6px');
    expect(sx[wrapSelector(SLOTS_LAYOUT)].whiteSpace).toBe('normal');
  });
});
