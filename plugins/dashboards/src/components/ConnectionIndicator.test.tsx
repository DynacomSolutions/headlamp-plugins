import { cleanup, render } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { Connection, ConnectionState } from '../resilience/connection';
import { ConnectionIndicator } from './ConnectionIndicator';

afterEach(cleanup);

function fake(state: ConnectionState): Connection {
  let current = state;
  const listeners = new Set<() => void>();
  return {
    getState: () => current,
    subscribe: l => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    start: () => undefined,
    stop: () => undefined,
    probeNow: async () => undefined,
    chunkFailed: () => {
      current = { ...current };
      listeners.forEach(l => l());
    },
  };
}

describe('ConnectionIndicator', () => {
  it('shows nothing while the server answers', () => {
    const { container } = render(
      <ConnectionIndicator
        connection={fake({ online: true, since: 0, lastOkAt: 1, failures: 0 })}
      />
    );
    expect(container.querySelector('[data-connection-indicator]')).toBeNull();
  });

  it('shows a calm note with the time since the server went away, with no alert role', () => {
    const since = new Date(2026, 10, 21, 17, 56, 12).getTime();
    const { container } = render(
      <ConnectionIndicator connection={fake({ online: false, since, lastOkAt: 1, failures: 3 })} />
    );
    const note = container.querySelector('[data-connection-indicator]') as HTMLElement;
    expect(note.textContent).toBe('Server unreachable since 17:56');
    expect(note.getAttribute('role')).toBe('status');
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
});
