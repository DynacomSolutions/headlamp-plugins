import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Detail } from './detail';

vi.mock('@kinvolk/headlamp-plugin/lib', () => ({ ApiProxy: { request: vi.fn() } }));
vi.mock('@iconify/react', () => ({ Icon: (p: { icon: string }) => <i data-icon={p.icon} /> }));

import { DetailPanel } from './DetailPanel';

const detail: Detail = {
  path: ['t3'],
  focus: {
    key: 't3',
    label: 'T3 Code',
    kind: 'orchestrator',
    cpu: 2,
    mem: 2 * 1024 ** 3,
    path: ['t3'],
    cpuParent: 4,
    memParent: 8 * 1024 ** 3,
  },
  children: [
    { key: 't3/p:a', label: 'alpha', kind: 'project', cpu: 1.5, mem: null, path: ['t3', 't3/p:a'] },
    {
      key: 't3/t:b',
      label: 'beta',
      kind: 'thread',
      cpu: 0.0001,
      mem: 1024,
      href: 'https://example.com/thread/b',
      path: ['t3', 't3/t:b'],
    },
  ],
  trail: [],
};

describe('DetailPanel', () => {
  afterEach(cleanup);

  it('shows the focus values with % of node and % of parent', () => {
    render(
      <DetailPanel
        detail={detail}
        cpuCapacity={16}
        memCapacity={16 * 1024 ** 3}
        onFocus={() => {}}
      />
    );
    expect(screen.getByRole('heading', { name: 'T3 Code' })).toBeTruthy();
    expect(screen.getAllByText('13% of node')).toHaveLength(2);
    expect(screen.getByText('50% of parent')).toBeTruthy();
    expect(screen.getByText('25% of parent')).toBeTruthy();
  });

  it('lists every child, however small, and a tap focuses it', () => {
    const onFocus = vi.fn();
    render(
      <DetailPanel
        detail={detail}
        cpuCapacity={16}
        memCapacity={16 * 1024 ** 3}
        onFocus={onFocus}
      />
    );
    expect(screen.getByText('alpha')).toBeTruthy();
    expect(screen.getByText('beta')).toBeTruthy();
    expect(screen.getByText(/no memory data/)).toBeTruthy();
    fireEvent.click(screen.getByText('beta'));
    expect(onFocus).toHaveBeenCalledWith(['t3', 't3/t:b']);
  });

  it('gives thread rows a thread link that does not focus the row', () => {
    const onFocus = vi.fn();
    render(
      <DetailPanel
        detail={detail}
        cpuCapacity={16}
        memCapacity={16 * 1024 ** 3}
        onFocus={onFocus}
      />
    );
    const links = screen.getAllByRole('link', { name: 'thread' });
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute('href')).toBe('https://example.com/thread/b');
    fireEvent.click(links[0]);
    expect(onFocus).not.toHaveBeenCalled();
  });
});
