import { describe, expect, it } from 'vitest';
import { CAUSE_LINES, CAUSE_MIN_CH, diagnosesLayout, tableSx, wrapSelector } from './tableLayout';

describe('diagnoses table layout', () => {
  it('counts the checkbox, the four short columns, the cause, the detail columns and the actions', () => {
    expect(diagnosesLayout({ checkbox: true, detail: true, actions: true })).toEqual({
      columns: 10,
      wrap: [2, 6],
    });
    expect(diagnosesLayout({ checkbox: false, detail: true, actions: false })).toEqual({
      columns: 8,
      wrap: [1, 5],
    });
  });

  it('lets only the time and the likely cause wrap', () => {
    for (const checkbox of [true, false]) {
      for (const detail of [true, false]) {
        for (const actions of [true, false]) {
          const l = diagnosesLayout({ checkbox, detail, actions });
          const first = checkbox ? 1 : 0;
          expect(l.wrap).toEqual([first + 1, first + 5]);
          expect(Math.max(...l.wrap)).toBeLessThanOrEqual(l.columns);
        }
      }
    }
  });

  it('builds a selector for the wrapping body cells only', () => {
    expect(wrapSelector({ columns: 6, wrap: [2, 6] })).toBe(
      '& td:nth-of-type(2), & td:nth-of-type(6)'
    );
  });

  it('keeps the other cells on one line, gives the cause a minimum and sets no table minimum', () => {
    const l = diagnosesLayout({ checkbox: true, detail: true, actions: true });
    const sx = tableSx(l) as Record<string, Record<string, unknown> | string>;
    expect(sx.width).toBe('100%');
    expect(sx.minWidth).toBeUndefined();
    expect((sx['& td'] as Record<string, unknown>).whiteSpace).toBe('nowrap');
    expect((sx['& th'] as Record<string, unknown>).whiteSpace).toBe('nowrap');
    expect((sx[wrapSelector(l)] as Record<string, unknown>).whiteSpace).toBe('normal');
    const cause = sx['& td:nth-of-type(6)'] as Record<string, unknown>;
    expect(cause.minWidth).toBe(`${CAUSE_MIN_CH}ch`);
    expect(cause.overflowWrap).toBe('anywhere');
    expect((sx[wrapSelector(l)] as Record<string, unknown>).overflowWrap).toBeUndefined();
  });

  it('clamps the cause at six lines, so a cause of about 140 characters shows in full', () => {
    expect(CAUSE_LINES).toBe(6);
  });
});
