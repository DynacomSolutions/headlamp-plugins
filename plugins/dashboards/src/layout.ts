/*
 * Grid helpers: the saved positions use a 12 column grid. Small screens get fewer columns, and
 * react-grid-layout makes those layouts from the 12 column one. Only the 12 column layouts are
 * editable and saved, so a narrow window never rewrites the saved positions.
 */
import type { Layout } from 'react-grid-layout';
import type { WidgetDefinition } from './contract';
import { GRID_COLUMNS, WidgetInstance } from './spec/model';

export type Breakpoint = 'lg' | 'md' | 'sm' | 'xs' | 'xxs';
export const BREAKPOINTS: Record<Breakpoint, number> = {
  lg: 1200,
  md: 900,
  sm: 600,
  xs: 380,
  xxs: 0,
};
export const COLS: Record<Breakpoint, number> = {
  lg: GRID_COLUMNS,
  md: GRID_COLUMNS,
  sm: 6,
  xs: 2,
  xxs: 2,
};
export const ROW_HEIGHT = 30;
export const GRID_MARGIN: [number, number] = [8, 8];

/** True for a breakpoint with the full 12 columns, where the layout can be edited. */
export const isEditableBreakpoint = (bp: Breakpoint): boolean => COLS[bp] === GRID_COLUMNS;

/** Which breakpoint a pixel width falls in. Used where the grid does not tell us. */
export function breakpointFor(width: number): Breakpoint {
  const order: Breakpoint[] = ['lg', 'md', 'sm', 'xs', 'xxs'];
  return order.find(bp => width >= BREAKPOINTS[bp]) ?? 'xxs';
}

type Limits = Pick<WidgetDefinition, 'minSize' | 'maxSize'> | undefined;

export function toLayout(widgets: WidgetInstance[], limitsOf: (type: string) => Limits): Layout[] {
  return widgets.map(w => {
    const l = limitsOf(w.type);
    const item: Layout = {
      i: w.id,
      x: w.x,
      y: w.y,
      w: w.w,
      h: w.h,
      minW: l?.minSize?.w ?? 1,
      minH: l?.minSize?.h ?? 1,
    };
    if (l?.maxSize) {
      item.maxW = l.maxSize.w;
      item.maxH = l.maxSize.h;
    }
    return item;
  });
}

export const layoutPositions = (layout: ReadonlyArray<Layout>) =>
  layout.map(({ i, x, y, w, h }) => ({ i, x, y, w, h }));

/** Whether a layout from the grid says the same as the saved positions. */
export function sameLayout(layout: ReadonlyArray<Layout>, widgets: WidgetInstance[]): boolean {
  if (layout.length !== widgets.length) return false;
  const byId = new Map(widgets.map(w => [w.id, w]));
  return layout.every(l => {
    const w = byId.get(l.i);
    return !!w && w.x === l.x && w.y === l.y && w.w === l.w && w.h === l.h;
  });
}

/** Total grid rows used, for a section's minimum height. */
export const rowsUsed = (widgets: WidgetInstance[]): number =>
  widgets.reduce((m, w) => Math.max(m, w.y + w.h), 0);

/** The pointer position of a mouse, pointer or touch event, or null. */
export function pointerOf(e: unknown): { x: number; y: number } | null {
  const ev = e as {
    clientX?: number;
    clientY?: number;
    changedTouches?: ArrayLike<{ clientX: number; clientY: number }>;
  } | null;
  if (!ev) return null;
  if (typeof ev.clientX === 'number' && typeof ev.clientY === 'number')
    return { x: ev.clientX, y: ev.clientY };
  const t = ev.changedTouches?.[0];
  return t ? { x: t.clientX, y: t.clientY } : null;
}

/**
 * The id of another section under a point, or null. Used when a drag ends: a drop on a
 * different section moves the widget there. Sections carry `data-section-id`.
 */
export function otherSectionAt(
  point: { x: number; y: number },
  fromSectionId: string,
  doc: Document = document
): string | null {
  const stack =
    typeof doc.elementsFromPoint === 'function' ? doc.elementsFromPoint(point.x, point.y) : [];
  for (const el of stack) {
    const id = el.closest('[data-section-id]')?.getAttribute('data-section-id');
    if (id && id !== fromSectionId) return id;
  }
  return null;
}
