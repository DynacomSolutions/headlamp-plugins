import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getSelectedIncident,
  hasChatWidget,
  registerChatWidget,
  selectIncident,
  useHasChatWidget,
  useSelectedIncident,
} from './selection';

afterEach(() => {
  cleanup();
  selectIncident(null);
});

function Probe() {
  const sel = useSelectedIncident();
  const chat = useHasChatWidget();
  return (
    <div>
      <span data-testid="sel">{sel?.id ?? 'none'}</span>
      <span data-testid="chat">{String(chat)}</span>
    </div>
  );
}

describe('selection store', () => {
  it('shares the selection with every subscriber', () => {
    render(<Probe />);
    expect(screen.getByTestId('sel').textContent).toBe('none');
    act(() => selectIncident({ id: 'd1', alertName: 'HighCPU' }));
    expect(screen.getByTestId('sel').textContent).toBe('d1');
    expect(getSelectedIncident()?.alertName).toBe('HighCPU');
    act(() => selectIncident(null));
    expect(screen.getByTestId('sel').textContent).toBe('none');
  });
  it('keeps the same object for the same selection, so nothing rerenders', () => {
    selectIncident({ id: 'd1', alertName: 'A' });
    const first = getSelectedIncident();
    selectIncident({ id: 'd1', alertName: 'A' });
    expect(getSelectedIncident()).toBe(first);
  });
  it('counts the mounted chat widgets', () => {
    render(<Probe />);
    expect(hasChatWidget()).toBe(false);
    let off = () => {};
    act(() => {
      off = registerChatWidget();
    });
    expect(screen.getByTestId('chat').textContent).toBe('true');
    act(() => off());
    expect(screen.getByTestId('chat').textContent).toBe('false');
  });
});
