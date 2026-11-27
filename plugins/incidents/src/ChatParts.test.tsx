import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Composer,
  ContextMeter,
  latestContext,
  MessageView,
  Reasoning,
  StreamedAnswer,
  ToolCard,
  UsageLine,
  useRevealedText,
  WorkingIndicator,
} from './ChatParts';

function reduceMotion(on: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: on && query.includes('prefers-reduced-motion'),
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    onchange: null,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

beforeEach(() => reduceMotion(false));
afterEach(() => vi.useRealTimers());

describe('smooth streaming text', () => {
  it('shows the whole text at once when the message is not animated (the history)', () => {
    const { result } = renderHook(() => useRevealedText('A full answer.', false));
    expect(result.current).toBe('A full answer.');
  });

  it('reveals a watched answer step by step and ends on the whole text', () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance'] });
    const text = 'word '.repeat(200);
    const { result } = renderHook(() => useRevealedText(text, true));
    expect(result.current.length).toBeLessThan(text.length);
    act(() => {
      vi.advanceTimersByTime(40);
    });
    const early = result.current.length;
    expect(early).toBeGreaterThan(0);
    expect(early).toBeLessThan(text.length);
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(result.current).toBe(text);
  });

  it('shows the whole text at once with reduced motion', () => {
    reduceMotion(true);
    const { result } = renderHook(() => useRevealedText('Reduced motion text.', true));
    expect(result.current).toBe('Reduced motion text.');
  });

  it('renders the revealed Markdown of an answer', () => {
    reduceMotion(true);
    render(<StreamedAnswer source={'The **pod** failed.'} animate />);
    expect(screen.getByText('pod', { selector: 'strong' })).toBeTruthy();
  });
});

describe('Reasoning', () => {
  it('is open while the turn runs, closes when it ends, and follows a manual choice', () => {
    const { rerender } = render(<Reasoning text="Looking at the pod." running animate={false} />);
    const toggle = screen.getByRole('button', { name: /Thinking/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Looking at the pod.')).toBeTruthy();
    rerender(<Reasoning text="Looking at the pod." running={false} animate={false} durationMs={12000} provider="claude" />);
    const done = screen.getByRole('button', { name: /Thought for 12 s/ });
    expect(done.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(done);
    expect(done.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Looking at the pod.')).toBeTruthy();
  });
});

describe('ToolCard', () => {
  const base = { id: 's1', tool: 'get_resource', reason: 'Is the pod healthy?', status: 'done' as const };

  it('shows the status, the duration, and opens to the arguments and the result by keyboard', () => {
    render(
      <ToolCard
        step={{ ...base, ok: true, durationMs: 1800, summary: 'Pod is Running.', args: { kind: 'Pod' }, output: '{"phase":"Running"}' }}
        animate={false}
      />
    );
    expect(screen.getByLabelText('Succeeded')).toBeTruthy();
    expect(screen.getByText('2 s')).toBeTruthy();
    const card = screen.getByRole('button', { name: /get_resource/ });
    expect(card.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(card);
    expect(card.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Arguments')).toBeTruthy();
    expect(screen.getByText(/"kind": "Pod"/)).toBeTruthy();
    expect(screen.getByText('Pod is Running.')).toBeTruthy();
  });

  it('counts the time of a running call live and has no detail to open yet', () => {
    vi.useFakeTimers();
    const startedAt = new Date(Date.now() - 3000).toISOString();
    render(<ToolCard step={{ ...base, status: 'running', startedAt }} animate={false} />);
    expect(screen.getByRole('progressbar', { name: 'Running' })).toBeTruthy();
    expect(screen.getByText('3 s')).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByText('5 s')).toBeTruthy();
    expect(screen.getByRole('button', { name: /get_resource/ }).hasAttribute('disabled')).toBe(true);
  });

  it('marks a failed call', () => {
    render(<ToolCard step={{ ...base, ok: false, summary: 'denied' }} animate={false} />);
    expect(screen.getByLabelText('Failed')).toBeTruthy();
  });
});

describe('ContextMeter', () => {
  it('is a meter with the used and the window tokens', () => {
    render(<ContextMeter used={24000} window={200000} />);
    const meter = screen.getByRole('meter', { name: 'Context window' });
    expect(meter.getAttribute('aria-valuenow')).toBe('24000');
    expect(meter.getAttribute('aria-valuemax')).toBe('200000');
    expect(meter.textContent).toContain('24k / 200k');
    expect(meter.getAttribute('aria-valuetext')).toContain('12%');
  });
  it('shows the tokens alone when the window is not known, and nothing when there are none', () => {
    const { rerender, container } = render(<ContextMeter used={3500} />);
    expect(screen.getByLabelText('Context window').textContent).toContain('3.5k tokens');
    expect(screen.queryByRole('meter')).toBeNull();
    rerender(<ContextMeter used={0} />);
    expect(container.textContent).toBe('');
  });
  it('takes the context of the last answer that reports one', () => {
    expect(latestContext([])).toEqual({ used: 0 });
    const usage = { inputTokens: 1, outputTokens: 1, calls: 1 };
    const messages = [
      { usage: { ...usage, contextTokens: 100, contextWindow: 1000 } },
      { usage: undefined },
    ] as any;
    expect(latestContext(messages)).toEqual({ used: 100, window: 1000 });
  });
});

describe('UsageLine', () => {
  it('shows the model, identity, tokens, cost, time and tool calls', () => {
    render(
      <UsageLine
        model="claude/claude-opus-5-5"
        toolCalls={1}
        usage={{ inputTokens: 1200, outputTokens: 80, contextTokens: 1200, calls: 1, costUsd: 0.5, identity: 'Account A', durationMs: 90000 }}
      />
    );
    const text = document.querySelector('[data-usage-line]')!.textContent!;
    for (const part of ['claude-opus-5-5', 'Account A', '1.2k in', '80 out', '$0.500', '1 min 30 s', '1 tool call']) {
      expect(text).toContain(part);
    }
  });
  it('shows nothing when there is nothing to show', () => {
    const { container } = render(<UsageLine toolCalls={0} />);
    expect(container.textContent).toBe('');
  });
});

describe('WorkingIndicator', () => {
  it('says what the agent does and for how long', () => {
    vi.useFakeTimers();
    render(<WorkingIndicator since={new Date(Date.now() - 4000).toISOString()} label="Running get_resource" />);
    expect(screen.getByRole('status').textContent).toContain('Running get_resource');
    expect(screen.getByRole('status').textContent).toContain('4 s');
  });
});

describe('Composer', () => {
  const props = { picker: <span>picker</span>, onSend: vi.fn() };
  it('sends on Enter, keeps Shift+Enter as a newline and clears the box', () => {
    const onSend = vi.fn();
    render(<Composer {...props} onSend={onSend} running={false} />);
    const box = screen.getByLabelText('Message') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'hello' } });
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('hello');
    expect(box.value).toBe('');
  });
  it('keeps send off for an empty message', () => {
    render(<Composer {...props} running={false} />);
    expect(screen.getByRole('button', { name: 'Send' }).hasAttribute('disabled')).toBe(true);
  });
  it('turns the send button into a stop button in the same place while a turn runs', () => {
    const onStop = vi.fn();
    render(<Composer {...props} running onStop={onStop} />);
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(onStop).toHaveBeenCalled();
  });
  it('shows the picker and the meter in the footer', () => {
    render(<Composer {...props} running={false} meter={<span>meter</span>} />);
    expect(screen.getByText('picker')).toBeTruthy();
    expect(screen.getByText('meter')).toBeTruthy();
  });
});

describe('the copy button', () => {
  it('stops its timer when it leaves, so it never sets state after unmount', async () => {
    vi.useFakeTimers();
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { unmount } = render(
      <MessageView m={{ id: 'm', role: 'assistant', text: 'An answer.', createdAt: new Date().toISOString(), status: 'done', steps: [] } as any} />
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy the answer' }));
    });
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    spy.mockRestore();
  });
});
