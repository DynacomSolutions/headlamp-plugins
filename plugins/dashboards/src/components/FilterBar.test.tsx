import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@iconify/react', () => ({ Icon: (p: { icon: string }) => <i data-icon={p.icon} /> }));

import { FilterBar } from './FilterBar';

const base = {
  filters: { namespaces: ['a'], nodes: [], labelSelector: '', range: '1h' as const },
  onChange: () => undefined,
  namespaceOptions: [],
  nodeOptions: [],
  views: [],
  activeView: '',
  onSelectView: () => undefined,
  onReset: () => undefined,
};

afterEach(cleanup);

describe('filter bar', () => {
  it('shows every field in the row by default', () => {
    render(<FilterBar {...base} />);
    expect(screen.getByLabelText('Namespaces')).toBeTruthy();
    expect(screen.getByLabelText('Nodes')).toBeTruthy();
    expect(screen.getByLabelText('Label selector')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Filters/ })).toBeNull();
  });

  it('folds the namespace, node and label fields into one button when compact', () => {
    render(<FilterBar {...base} compact />);
    expect(screen.queryByLabelText('Namespaces')).toBeNull();
    // The time range and the views stay in the row.
    expect(screen.getByLabelText('Time range')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Views/ })).toBeTruthy();
    // The button counts the active filters.
    const button = screen.getByRole('button', { name: 'Filters (1)' });
    fireEvent.click(button);
    expect(screen.getByLabelText('Namespaces')).toBeTruthy();
    expect(screen.getByLabelText('Nodes')).toBeTruthy();
    expect(screen.getByLabelText('Label selector')).toBeTruthy();
  });
});
