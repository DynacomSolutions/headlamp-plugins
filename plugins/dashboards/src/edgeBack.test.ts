import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installEdgeBack } from './edgeBack';

/** jsdom has no Touch, so a plain event carries the touch lists. */
function touch(
  type: string,
  x: number,
  y: number,
  t: number,
  target: EventTarget = document.body,
  fingers = 1
) {
  const e = new Event(type, { bubbles: true });
  const list = Array.from({ length: fingers }, (_, i) => ({ clientX: x + i * 10, clientY: y }));
  const ended = type === 'touchend' || type === 'touchcancel';
  Object.defineProperty(e, 'touches', { value: ended ? [] : list });
  Object.defineProperty(e, 'changedTouches', { value: list });
  Object.defineProperty(e, 'timeStamp', { value: t });
  target.dispatchEvent(e);
}

const hint = () => document.querySelector('[data-swipe-hint]');

let goBack: ReturnType<typeof vi.fn>;
let off: () => void;
beforeEach(() => {
  goBack = vi.fn();
  off = installEdgeBack(window, { goBack });
});
afterEach(() => {
  off();
  document.body.innerHTML = '';
});

describe('edge swipe back', () => {
  it('shows a hint while the finger moves and goes Back when it is released far enough', () => {
    touch('touchstart', 4, 400, 0);
    expect(hint()).toBeNull();
    touch('touchmove', 40, 405, 60);
    expect(hint()?.getAttribute('data-swipe-hint')).toBe('left');
    expect(hint()?.getAttribute('data-ready')).toBe('false');
    touch('touchmove', 120, 410, 120);
    expect(hint()?.getAttribute('data-ready')).toBe('true');
    touch('touchend', 120, 410, 160);
    expect(goBack).toHaveBeenCalledTimes(1);
    expect(hint()).toBeNull();
  });

  it('does not go Back when the swipe is too short, and removes the hint', () => {
    touch('touchstart', 4, 400, 0);
    touch('touchmove', 50, 400, 60);
    expect(hint()).not.toBeNull();
    touch('touchend', 50, 400, 100);
    expect(goBack).not.toHaveBeenCalled();
    expect(hint()).toBeNull();
  });

  it('ignores a swipe that does not start in the edge zone', () => {
    touch('touchstart', 200, 400, 0);
    touch('touchmove', 330, 400, 60);
    touch('touchend', 330, 400, 100);
    expect(goBack).not.toHaveBeenCalled();
    expect(hint()).toBeNull();
  });

  it('ignores a gesture with two fingers, also when the second finger comes later', () => {
    touch('touchstart', 4, 400, 0, document.body, 2);
    touch('touchmove', 120, 400, 60, document.body, 2);
    touch('touchend', 120, 400, 100);
    expect(goBack).not.toHaveBeenCalled();

    touch('touchstart', 4, 400, 200);
    touch('touchmove', 60, 400, 230, document.body, 2);
    touch('touchend', 120, 400, 260);
    expect(goBack).not.toHaveBeenCalled();
    expect(hint()).toBeNull();
  });

  it('leaves a sideways scroll area that is scrolled away from its left end', () => {
    document.body.innerHTML = '<div id="w"><span id="x"></span></div>';
    const w = document.querySelector('#w') as HTMLElement;
    w.style.overflowX = 'auto';
    Object.defineProperty(w, 'scrollWidth', { value: 900, configurable: true });
    Object.defineProperty(w, 'clientWidth', { value: 300, configurable: true });
    w.scrollLeft = 50;
    const x = document.querySelector('#x') as HTMLElement;
    touch('touchstart', 4, 400, 0, x);
    touch('touchmove', 120, 400, 60, x);
    touch('touchend', 120, 400, 100, x);
    expect(goBack).not.toHaveBeenCalled();
  });

  it('drops the gesture when it turns vertical or is cancelled', () => {
    touch('touchstart', 4, 400, 0);
    touch('touchmove', 14, 470, 40);
    touch('touchend', 120, 470, 100);
    expect(goBack).not.toHaveBeenCalled();

    touch('touchstart', 4, 400, 200);
    touch('touchmove', 60, 400, 230);
    expect(hint()).not.toBeNull();
    touch('touchcancel', 60, 400, 260);
    expect(hint()).toBeNull();
    touch('touchend', 120, 400, 300);
    expect(goBack).not.toHaveBeenCalled();
  });

  it('drops the gesture when text becomes selected', () => {
    touch('touchstart', 4, 400, 0);
    touch('touchmove', 60, 400, 40);
    expect(hint()).not.toBeNull();
    document.dispatchEvent(new Event('selectionchange'));
    expect(hint()).toBeNull();
    touch('touchend', 120, 400, 100);
    expect(goBack).not.toHaveBeenCalled();
  });

  it('goes Back with the history of the window by default', () => {
    off();
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => undefined);
    off = installEdgeBack(window);
    touch('touchstart', 4, 400, 0);
    touch('touchmove', 100, 400, 60);
    touch('touchend', 100, 400, 100);
    expect(back).toHaveBeenCalledTimes(1);
    back.mockRestore();
  });

  it('removes its listeners', () => {
    off();
    touch('touchstart', 4, 400, 0);
    touch('touchmove', 100, 400, 60);
    touch('touchend', 100, 400, 100);
    expect(goBack).not.toHaveBeenCalled();
  });
});
