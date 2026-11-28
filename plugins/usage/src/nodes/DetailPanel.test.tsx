import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Selection } from './detail';

vi.mock('@iconify/react', () => ({ Icon: () => <i /> }));
vi.mock('./useIconUrl', () => ({ useIconUrl: () => null }));

import { DetailPanel } from './DetailPanel';
import { threadLink } from './ThreadLink';

afterEach(cleanup);

const subject: Selection = {
  label: 'thread-1',
  kind: 'thread',
  href: 'https://threads.example.com/t/1',
  canOpen: false,
  cpu: { value: 1, ofCapacity: 0.1, ofParent: 0.5, ofRoot: 0.2 },
  mem: { value: 1024, ofCapacity: 0.1, ofParent: 0.5, ofRoot: 0.2 },
};

const panel = (extra: Partial<React.ComponentProps<typeof DetailPanel>> = {}) =>
  render(
    <DetailPanel
      subject={subject}
      selected
      rows={[]}
      section="Node"
      onSelect={() => undefined}
      {...extra}
    />
  );

describe('the thread link of the detail panel', () => {
  it('is a copy button with no anchor in a dashboard (no threadLink passed)', () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const { container } = panel();
    expect(container.querySelector('a')).toBeNull();
    expect(container.querySelector('[href], [target]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Copy thread link' }));
    expect(writeText).toHaveBeenCalledWith('https://threads.example.com/t/1');
  });

  it('is a link that opens a new tab on the usage page', () => {
    const { container } = panel({ threadLink });
    const a = container.querySelector('a') as HTMLAnchorElement;
    expect(a.getAttribute('href')).toBe('https://threads.example.com/t/1');
    expect(a.getAttribute('target')).toBe('_blank');
  });
});
