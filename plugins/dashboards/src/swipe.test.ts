import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AXIS_RATIO,
  BACK_DISTANCE,
  blocksSwipe,
  EDGE_ZONE,
  MAX_DURATION,
  SwipeTracker,
  TAB_DISTANCE,
} from './swipe';

const at = (x: number, y: number, t = 0) => ({ x, y, t });

describe('SwipeTracker, edge mode', () => {
  it('starts only in the left edge zone', () => {
    expect(new SwipeTracker('edge').begin(at(EDGE_ZONE, 300))).toBe(true);
    expect(new SwipeTracker('edge').begin(at(EDGE_ZONE + 1, 300))).toBe(false);
  });

  it('goes Back after a long enough swipe to the right', () => {
    const t = new SwipeTracker('edge');
    t.begin(at(5, 300));
    expect(t.end(at(5 + BACK_DISTANCE, 310, 200))).toEqual({ type: 'back' });
    expect(t.active).toBe(false);
  });

  it('does nothing for a short swipe', () => {
    const t = new SwipeTracker('edge');
    t.begin(at(5, 300));
    expect(t.end(at(5 + BACK_DISTANCE - 1, 300, 100))).toBeNull();
  });

  it('does nothing for a swipe to the left, a slow swipe or an up and down move', () => {
    const left = new SwipeTracker('edge');
    left.begin(at(10, 300));
    expect(left.move(at(-40, 300, 50)).live).toBe(false);
    expect(left.end(at(-100, 300, 100))).toBeNull();

    const slow = new SwipeTracker('edge');
    slow.begin(at(5, 300));
    expect(slow.end(at(200, 300, MAX_DURATION + 1))).toBeNull();

    const vertical = new SwipeTracker('edge');
    vertical.begin(at(5, 300));
    expect(
      vertical.end(at(5 + BACK_DISTANCE, 300 + (BACK_DISTANCE / AXIS_RATIO) * 1.2, 100))
    ).toBeNull();
  });

  it('reports progress for the hint and ends a gesture that turns vertical', () => {
    const t = new SwipeTracker('edge');
    t.begin(at(5, 300));
    expect(t.move(at(5 + BACK_DISTANCE / 2, 302, 40))).toMatchObject({ live: true, progress: 0.5 });
    expect(t.move(at(5 + BACK_DISTANCE * 3, 302, 80)).progress).toBe(1);
    const v = new SwipeTracker('edge');
    v.begin(at(5, 300));
    expect(v.move(at(12, 360, 40)).live).toBe(false);
    expect(v.active).toBe(false);
  });
});

describe('SwipeTracker, tab mode', () => {
  it('never starts in the edge zone, so it cannot compete with Back', () => {
    expect(new SwipeTracker('tab').begin(at(EDGE_ZONE, 300))).toBe(false);
    expect(new SwipeTracker('tab').begin(at(EDGE_ZONE + 1, 300))).toBe(true);
  });

  it('steps to the next tab on a swipe left and to the previous tab on a swipe right', () => {
    const l = new SwipeTracker('tab');
    l.begin(at(300, 300));
    expect(l.end(at(300 - TAB_DISTANCE, 305, 200))).toEqual({ type: 'tab', step: 1 });
    const r = new SwipeTracker('tab');
    r.begin(at(300, 300));
    expect(r.end(at(300 + TAB_DISTANCE, 295, 200))).toEqual({ type: 'tab', step: -1 });
  });

  it('ignores a short, slow or diagonal move', () => {
    const short = new SwipeTracker('tab');
    short.begin(at(300, 300));
    expect(short.end(at(300 - TAB_DISTANCE + 1, 300, 100))).toBeNull();
    const slow = new SwipeTracker('tab');
    slow.begin(at(300, 300));
    expect(slow.end(at(100, 300, MAX_DURATION + 1))).toBeNull();
    const diagonal = new SwipeTracker('tab');
    diagonal.begin(at(300, 300));
    expect(diagonal.end(at(200, 380, 200))).toBeNull();
  });
});

function page(html: string): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = html;
  document.body.appendChild(root);
  return root;
}

function scrollable(el: HTMLElement, scrollLeft: number): void {
  el.style.overflowX = 'auto';
  Object.defineProperty(el, 'scrollWidth', { value: 900, configurable: true });
  Object.defineProperty(el, 'clientWidth', { value: 300, configurable: true });
  el.scrollLeft = scrollLeft;
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('blocksSwipe', () => {
  it('lets a swipe on plain content through', () => {
    const root = page('<div id="a"><p id="b">text</p></div>');
    expect(blocksSwipe(root.querySelector('#b'), 'tab', window)).toBe(false);
    expect(blocksSwipe(root.querySelector('#b'), 'edge', window)).toBe(false);
  });

  it('leaves text fields, sliders and marked elements to themselves', () => {
    const root = page(
      '<input id="i"><textarea id="t"></textarea><div role="slider" id="s"><span id="c"></span></div><div data-no-swipe id="n"></div>'
    );
    for (const id of ['#i', '#t', '#c', '#n'])
      expect(blocksSwipe(root.querySelector(id), 'tab', window)).toBe(true);
  });

  it('leaves a sideways scroll area to itself for a tab swipe', () => {
    const root = page('<div id="w"><div id="x"></div></div>');
    scrollable(root.querySelector('#w') as HTMLElement, 0);
    expect(blocksSwipe(root.querySelector('#x'), 'tab', window)).toBe(true);
  });

  it('lets the edge swipe through a scroll area at its left end and blocks it away from the end', () => {
    const root = page('<div id="w"><div id="x"></div></div>');
    const w = root.querySelector('#w') as HTMLElement;
    scrollable(w, 0);
    expect(blocksSwipe(root.querySelector('#x'), 'edge', window)).toBe(false);
    scrollable(w, 120);
    expect(blocksSwipe(root.querySelector('#x'), 'edge', window)).toBe(true);
  });

  it('stops at the root element', () => {
    const root = page('<div id="outer"><div id="area"><p id="p"></p></div></div>');
    scrollable(root.querySelector('#outer') as HTMLElement, 0);
    expect(blocksSwipe(root.querySelector('#p'), 'tab', window, root.querySelector('#area'))).toBe(
      false
    );
  });

  it('leaves the gesture to the text selection', () => {
    const root = page('<p id="p">some text</p>');
    const sel = { isCollapsed: false, toString: () => 'some' } as unknown as Selection;
    vi.spyOn(window, 'getSelection').mockReturnValue(sel);
    expect(blocksSwipe(root.querySelector('#p'), 'tab', window)).toBe(true);
    expect(blocksSwipe(root.querySelector('#p'), 'edge', window)).toBe(true);
  });
});
