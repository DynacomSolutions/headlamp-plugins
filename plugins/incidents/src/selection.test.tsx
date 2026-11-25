import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getSelectedIncident,
  getSelection,
  hasChatWidget,
  registerChatWidget,
  resetFocus,
  selectIncident,
  setSelection,
  useFocus,
  useHasChatWidget,
  useSelection,
} from './selection';

afterEach(() => {
  cleanup();
  setSelection(null);
  resetFocus();
});

function Probe() {
  const sel = useSelection();
  const chat = useHasChatWidget();
  return (
    <div>
      <span data-testid="sel">
        {sel ? (sel.kind === 'incident' ? sel.id : `group ${sel.name}`) : 'none'}
      </span>
      <span data-testid="chat">{String(chat)}</span>
    </div>
  );
}

const GROUP = {
  kind: 'group' as const,
  name: 'HighCPU',
  ids: ['2', '1'],
  worst: 'critical' as const,
  view: 'open' as const,
};

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
    const first = getSelection();
    selectIncident({ id: 'd1', alertName: 'A' });
    expect(getSelection()).toBe(first);
    setSelection(GROUP);
    const group = getSelection();
    setSelection({ ...GROUP, ids: ['2', '1'] });
    expect(getSelection()).toBe(group);
  });
  it('replaces a group by an incident and the reverse, never both', () => {
    render(<Probe />);
    act(() => setSelection(GROUP));
    expect(screen.getByTestId('sel').textContent).toBe('group HighCPU');
    expect(getSelectedIncident()).toBeNull();
    act(() => selectIncident({ id: 'd9', alertName: 'DiskFull' }));
    expect(screen.getByTestId('sel').textContent).toBe('d9');
    expect(getSelection()?.kind).toBe('incident');
    act(() => setSelection(GROUP));
    expect(screen.getByTestId('sel').textContent).toBe('group HighCPU');
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

describe('the focus of a widget', () => {
  function Focus(props: { focus?: string[]; setFocus?: (s: string[] | null) => void }) {
    const f = useFocus(props);
    return (
      <div>
        <span data-testid="f">{f.focus.join('|')}</span>
        <button onClick={() => f.setFocus(['group', 'A'])}>set</button>
        <button onClick={() => f.setFocus(null)}>clear</button>
      </div>
    );
  }
  it('uses the URL focus and setter of the dashboard when it gives them', () => {
    const calls: Array<string[] | null> = [];
    render(<Focus focus={['incident', 'd1']} setFocus={s => calls.push(s)} />);
    expect(screen.getByTestId('f').textContent).toBe('incident|d1');
    act(() => screen.getByText('set').click());
    act(() => screen.getByText('clear').click());
    expect(calls).toEqual([['group', 'A'], null]);
    // The URL decides: the memory focus is unchanged.
    expect(screen.getByTestId('f').textContent).toBe('incident|d1');
  });
  it('keeps the focus in memory for an older Dashboards plugin, shared by both widgets', () => {
    render(
      <>
        <Focus />
        <Focus />
      </>
    );
    const [a, b] = screen.getAllByTestId('f');
    act(() => screen.getAllByText('set')[0].click());
    expect(a.textContent).toBe('group|A');
    expect(b.textContent).toBe('group|A');
    act(() => screen.getAllByText('clear')[1].click());
    expect(a.textContent).toBe('');
  });
});
