import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AgentStatusPill } from './AgentStatusPill';
import { AgentTimeline, groupByRun } from './AgentTimeline';
import { LAUNCH } from './launch.fixture';
import { LAUNCH_STATUSES, parseLaunch, statusMeta } from './launch-model';
import { ApprovalCard } from './LaunchApproval';

describe('AgentStatusPill', () => {
  it('shows the label, the colour class data and the elapsed time for each status', () => {
    for (const s of LAUNCH_STATUSES) {
      const { unmount } = render(<AgentStatusPill status={s} elapsed="12 s" />);
      const pill = screen.getByRole('status');
      expect(pill.getAttribute('data-status')).toBe(s);
      expect(within(pill).getByText(statusMeta(s).label)).toBeTruthy();
      expect(within(pill).getByText('12 s')).toBeTruthy();
      unmount();
    }
  });

  it('shows tracking lost as a retrying state with a spinner, and expired as an end state', () => {
    const { container, unmount } = render(<AgentStatusPill status="tracking_lost" />);
    expect(screen.getByText('Tracking lost, retrying')).toBeTruthy();
    expect(container.querySelector('[role="progressbar"]')).toBeTruthy();
    unmount();
    const expired = render(<AgentStatusPill status="expired" />);
    expect(screen.getByText('Expired')).toBeTruthy();
    expect(expired.container.querySelector('[role="progressbar"]')).toBeNull();
  });

  it('shows what the agent does now', () => {
    render(<AgentStatusPill status="running" activity="kubectl get nodes" />);
    expect(screen.getByText('kubectl get nodes')).toBeTruthy();
  });
});

describe('AgentTimeline', () => {
  const now = Date.parse('2026-11-20T07:00:50.000Z');
  const timeline = parseLaunch(LAUNCH).timeline;

  it('groups the steps under their run', () => {
    const groups = groupByRun(timeline);
    expect(groups).toHaveLength(1);
    expect(groups[0].run?.title).toBe('Run 1');
    expect(groups[0].steps.map(s => s.id)).toEqual(['m1', 't1', 'f1', 't2']);
  });

  it('renders the runs, the steps and the counts', () => {
    render(<AgentTimeline timeline={timeline} now={now} />);
    expect(screen.getByText('Run 1')).toBeTruthy();
    expect(screen.getByText('1 run, 4 steps')).toBeTruthy();
    expect(screen.getByText('dig app.example.com')).toBeTruthy();
    expect(screen.getByText('notes.txt')).toBeTruthy();
    expect(screen.getByLabelText('Failed')).toBeTruthy();
  });

  it('shows a live timer for a running step', () => {
    render(<AgentTimeline timeline={timeline} now={now} />);
    // kubectl get nodes started at 07:00:20 and runs until now (07:00:50).
    expect(screen.getByText('30 s')).toBeTruthy();
    render(<AgentTimeline timeline={timeline} now={now + 5000} />);
    expect(screen.getByText('35 s')).toBeTruthy();
  });

  it('expands a tool card to show its detail', () => {
    render(<AgentTimeline timeline={timeline} now={now} />);
    const head = screen.getByRole('button', { name: /dig app.example.com/ });
    expect(head.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText(/exit code 0/)).toBeNull();
    fireEvent.click(head);
    expect(head.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText(/exit code 0/)).toBeTruthy();
  });

  it('does not make a step without detail expandable', () => {
    render(<AgentTimeline timeline={timeline} now={now} />);
    expect(screen.queryByRole('button', { name: /kubectl get nodes/ })).toBeNull();
    expect(screen.getByText('kubectl get nodes')).toBeTruthy();
  });

  it('says so when there is no step yet', () => {
    render(<AgentTimeline timeline={[]} now={now} />);
    expect(screen.getByText('The agent has not reported a step yet.')).toBeTruthy();
  });
});

describe('ApprovalCard', () => {
  it('calls approve and reject and states the one-operator rule', () => {
    const onApprove = vi.fn();
    const onReject = vi.fn();
    render(
      <ApprovalCard
        purpose="Apply the plan"
        requestedBy="alice"
        brief={'## Purpose\nApply the plan'}
        busy={false}
        onApprove={onApprove}
        onReject={onReject}
      />
    );
    expect(screen.getByText(/You may approve your own request/)).toBeTruthy();
    expect(screen.getByText(/alice asked to run an agent/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Approve and launch' }));
    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onReject).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    expect(onReject).toHaveBeenCalledTimes(1);
  });

  it('disables both buttons while busy and shows an error', () => {
    render(
      <ApprovalCard
        purpose="x"
        brief="the brief"
        busy
        error="2 launches are active already"
        onApprove={() => {}}
        onReject={() => {}}
      />
    );
    expect(
      (screen.getByRole('button', { name: 'Approve and launch' }) as HTMLButtonElement).disabled
    ).toBe(true);
    expect((screen.getByRole('button', { name: 'Reject' }) as HTMLButtonElement).disabled).toBe(
      true
    );
    expect(screen.getByText('2 launches are active already')).toBeTruthy();
  });

  it('shows the exact brief above the buttons, with the sentence that says so', () => {
    const brief = '## Purpose\nApply the plan\n\n```json\n{"a": 1}\n```';
    render(
      <ApprovalCard
        purpose="x"
        brief={brief}
        busy={false}
        onApprove={() => {}}
        onReject={() => {}}
      />
    );
    expect(screen.getByText('This is the exact brief the agent gets.')).toBeTruthy();
    const block = screen.getByLabelText('Brief the agent gets');
    expect(block.tagName).toBe('PRE');
    expect(block.textContent).toBe(brief);
    const approve = screen.getByRole('button', { name: 'Approve and launch' });
    // The brief comes before the Approve button in the page.
    expect(block.compareDocumentPosition(approve) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('does not allow approval before the brief has loaded', () => {
    render(
      <ApprovalCard
        purpose="x"
        brief={undefined}
        busy={false}
        onApprove={() => {}}
        onReject={() => {}}
      />
    );
    expect(screen.getByText('Loading...')).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Approve and launch' }) as HTMLButtonElement).disabled
    ).toBe(true);
  });
});
