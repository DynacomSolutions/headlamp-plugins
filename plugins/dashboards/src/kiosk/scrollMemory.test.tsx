import { act, cleanup, render } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadScroll, saveScroll, SCROLL_KEY, useScrollMemory } from './scrollMemory';

function Probe({ id, height }: { id: string; height: number }): JSX.Element {
  const [el, setEl] = React.useState<HTMLElement | null>(null);
  useScrollMemory(el, id);
  return (
    <div ref={setEl} data-testid="scroller">
      <div style={{ height }} />
    </div>
  );
}

/** jsdom has no layout: give the scroller a size, and let the test move scrollTop. */
function size(el: HTMLElement, scrollHeight: number, clientHeight: number) {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, value: scrollHeight });
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: clientHeight });
}

beforeEach(() => sessionStorage.clear());
afterEach(cleanup);

describe('scroll memory', () => {
  it('saves and loads a position per id, and treats bad data as the top', () => {
    saveScroll(sessionStorage, 'a/b', 321.4);
    expect(loadScroll(sessionStorage, 'a/b')).toBe(321);
    expect(loadScroll(sessionStorage, 'other')).toBe(0);
    sessionStorage.setItem(`${SCROLL_KEY}:bad`, 'abc');
    expect(loadScroll(sessionStorage, 'bad')).toBe(0);
  });

  it('keeps the scroll position while the user scrolls', () => {
    const { getByTestId } = render(<Probe id="ns/ops/overview" height={3000} />);
    const el = getByTestId('scroller');
    el.scrollTop = 480;
    act(() => {
      el.dispatchEvent(new Event('scroll'));
    });
    expect(loadScroll(sessionStorage, 'ns/ops/overview')).toBe(480);
  });

  it('keeps the saved position while it waits for the content to grow', () => {
    saveScroll(sessionStorage, 'ns/ops/overview', 700);
    const { getByTestId } = render(<Probe id="ns/ops/overview" height={3000} />);
    const el = getByTestId('scroller');
    // jsdom has no layout, so the first try sees no room and waits.
    expect(el.scrollTop).toBe(0);
    size(el, 2000, 1000);
    act(() => {
      el.dispatchEvent(new Event('scroll'));
    });
    // The page did not move by itself yet: the restore runs on the next size change or retry.
    expect(loadScroll(sessionStorage, 'ns/ops/overview')).toBe(700);
  });

  it('restores at mount when the content is already tall', () => {
    saveScroll(sessionStorage, 'k', 650);
    const Tall = () => {
      const [el, setEl] = React.useState<HTMLElement | null>(null);
      if (el) size(el, 4000, 1000);
      useScrollMemory(el, 'k');
      return (
        <div ref={setEl} data-testid="s">
          <div />
        </div>
      );
    };
    const { getByTestId, rerender } = render(<Tall />);
    rerender(<Tall />);
    expect(getByTestId('s').scrollTop).toBe(650);
  });

  it('does not overwrite the saved position with the empty page before the restore', () => {
    saveScroll(sessionStorage, 'k2', 900);
    const { getByTestId } = render(<Probe id="k2" height={10} />);
    const el = getByTestId('scroller');
    el.scrollTop = 0;
    act(() => {
      el.dispatchEvent(new Event('scroll'));
    });
    expect(loadScroll(sessionStorage, 'k2')).toBe(900);
  });

  it('does nothing without an id', () => {
    const { getByTestId } = render(<Probe id="" height={3000} />);
    const el = getByTestId('scroller');
    el.scrollTop = 50;
    act(() => {
      el.dispatchEvent(new Event('scroll'));
    });
    expect(sessionStorage.length).toBe(0);
  });
});
