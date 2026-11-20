import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@iconify/react', () => ({ Icon: (p: { icon: string }) => <i data-icon={p.icon} /> }));

import { DashboardSettingsDialog } from './components/DashboardSettingsDialog';
import { SectionView } from './components/SectionView';
import { TabsActions, TabsDialog } from './components/TabsDialog';
import { useFillRowHeight } from './fillHeight';
import { emptySection, emptySpec } from './spec/model';

afterEach(cleanup);

describe('useFillRowHeight', () => {
  const realHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
  const realRect = HTMLElement.prototype.getBoundingClientRect;
  const innerHeight = window.innerHeight;

  beforeEach(() => {
    // 20 rows: the content is 20 times the row height plus 50 px of margins, 100 px under the top.
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get(this: HTMLElement) {
        const rh = this.getAttribute('data-rh');
        return rh ? 20 * Number(rh) + 50 : 0;
      },
    });
    HTMLElement.prototype.getBoundingClientRect = function () {
      return { top: 100, bottom: 100, left: 0, right: 0, width: 0, height: 0 } as DOMRect;
    };
  });
  afterEach(() => {
    if (realHeight) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', realHeight);
    HTMLElement.prototype.getBoundingClientRect = realRect;
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: innerHeight });
  });

  function Probe(props: { enabled: boolean; rows?: number }) {
    const { ref, rowHeight } = useFillRowHeight(props.enabled, props.rows ?? 20, 'a');
    return <div ref={ref} data-testid="grid" data-rh={rowHeight} />;
  }
  const rh = () => Number(screen.getByTestId('grid').getAttribute('data-rh'));
  const setScreen = (h: number) => {
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: h });
    fireEvent(window, new Event('resize'));
  };

  it('fills the screen, follows a resize and stops at the minimum', async () => {
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 1000 });
    render(<Probe enabled />);
    // 900 px free, 650 px used at 30 px rows: 250 px over 20 rows, aiming 1.5 px short.
    await waitFor(() => expect(rh()).toBe(42.4));
    setScreen(1300);
    await waitFor(() => expect(rh()).toBe(57.4));
    setScreen(400);
    await waitFor(() => expect(rh()).toBe(30));
  });

  it('keeps the fixed height when off, and when there are no rows', () => {
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 1000 });
    const { unmount } = render(<Probe enabled={false} />);
    expect(rh()).toBe(30);
    unmount();
    render(<Probe enabled rows={0} />);
    expect(rh()).toBe(30);
  });

  it('goes back to the fixed height when it is turned off', async () => {
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 1000 });
    const { rerender } = render(<Probe enabled />);
    await waitFor(() => expect(rh()).toBe(42.4));
    rerender(<Probe enabled={false} />);
    await waitFor(() => expect(rh()).toBe(30));
    rerender(<Probe enabled />);
    await waitFor(() => expect(rh()).toBe(42.4));
  });
});

describe('the setting in the dialogs', () => {
  it('sends the dashboard setting with Apply', () => {
    const onApply = vi.fn();
    render(
      <DashboardSettingsDialog
        title="Ops"
        description=""
        kioskShowFilters={false}
        fitHeight
        onCancel={() => undefined}
        onApply={onApply}
      />
    );
    const toggle = screen.getByRole('checkbox', { name: 'Fit to screen height' });
    expect((toggle as HTMLInputElement).checked).toBe(true);
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(onApply).toHaveBeenCalledWith('Ops', '', false, false);
  });

  it('shows the tab override and calls setFitHeight', () => {
    const spec = emptySpec('Ops');
    spec.tabs[0].fitHeight = false;
    const setFitHeight = vi.fn();
    const actions = { setFitHeight } as unknown as TabsActions;
    render(<TabsDialog spec={spec} actions={actions} onClose={() => undefined} />);
    const select = screen.getByRole('combobox', { name: /Fit height of/ });
    expect(select.textContent).toBe('Off');
    fireEvent.mouseDown(select);
    fireEvent.click(screen.getByRole('option', { name: 'Dashboard (on)' }));
    expect(setFitHeight).toHaveBeenCalledWith(spec.tabs[0].id, undefined);
  });
});

describe('a self-scroll section in a tab that fits the screen', () => {
  const props = {
    index: 0,
    count: 1,
    editing: false,
    kiosk: false,
    frameActions: {} as never,
    actions: {} as never,
  };
  const scrollBox = (c: HTMLElement) => c.querySelector('[data-section-scroll]') as HTMLElement;

  it('keeps its fixed height while the tab does not fit', () => {
    const section = { ...emptySection('S'), mode: 'self-scroll' as const, height: 866 };
    const { container } = render(<SectionView {...props} section={section} />);
    expect(getComputedStyle(scrollBox(container)).height).toBe('866px');
  });

  it('gives up the fixed height, so the grid rows set the height', () => {
    const section = { ...emptySection('S'), mode: 'self-scroll' as const, height: 866 };
    const { container } = render(<SectionView {...props} section={section} fit rowHeight={50} />);
    expect(getComputedStyle(scrollBox(container)).height).not.toBe('866px');
    expect(getComputedStyle(scrollBox(container)).overflowY).not.toBe('auto');
  });
});
