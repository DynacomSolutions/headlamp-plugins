import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MODELS, MODELS_TWO_IDENTITIES } from './chat.fixture';
import { ModelPicker } from './ModelPicker';

function setup(over: Partial<React.ComponentProps<typeof ModelPicker>> = {}) {
  const props = {
    models: MODELS,
    value: 'claude/sonnet',
    onChange: vi.fn(),
    favourites: [] as string[],
    onToggleFavourite: vi.fn(),
    ...over,
  };
  render(<ModelPicker {...props} />);
  return props;
}
const openPicker = (name: RegExp | string = /Claude Sonnet/) =>
  fireEvent.click(screen.getByRole('button', { name }));
const search = () => screen.getByPlaceholderText('Search models...');
const optionNames = () => screen.queryAllByRole('option').map(o => o.textContent);

describe('ModelPicker', () => {
  it('shows the model name on the trigger, or Choose model', () => {
    setup();
    expect(screen.getByRole('button', { name: /Claude Sonnet/ })).toBeTruthy();
  });
  it('labels the trigger Choose model when nothing is selected', () => {
    setup({ value: '' });
    expect(screen.getByRole('button', { name: /Choose model/ })).toBeTruthy();
  });
  it('opens on the selected provider and marks the selected model', () => {
    setup();
    openPicker();
    expect(optionNames().join('|')).toContain('Claude Opus');
    expect(optionNames().join('|')).not.toContain('GPT 5');
    const selected = screen.getByRole('option', { selected: true });
    expect(selected.textContent).toContain('Claude Sonnet');
  });
  it('highlights the selected model on open, not the first of the provider', () => {
    setup();
    openPicker();
    const rows = Array.from(document.querySelectorAll('[data-highlighted]'));
    const lit = rows.filter(r => r.getAttribute('data-highlighted') === 'true');
    expect(lit).toHaveLength(1);
    expect(lit[0].textContent).toContain('Claude Sonnet');
    expect(within(lit[0] as HTMLElement).getByRole('option').querySelector('svg, span')).toBeTruthy();
  });
  it('moves the highlight to the first result when the search text changes', () => {
    setup();
    openPicker();
    fireEvent.change(search(), { target: { value: 'claude' } });
    const lit = Array.from(document.querySelectorAll('[data-highlighted="true"]'));
    expect(lit).toHaveLength(1);
    expect(lit[0].textContent).toContain('Claude Opus');
  });
  it('switches provider from the sidebar', () => {
    setup();
    openPicker();
    fireEvent.click(screen.getByRole('tab', { name: 'Codex' }));
    expect(optionNames().join('|')).toContain('GPT 5');
    expect(optionNames().join('|')).not.toContain('Claude Opus');
  });
  it('lists Favourites first in the sidebar with an empty state', () => {
    setup({ value: '' });
    openPicker(/Choose model/);
    const tabs = screen.getAllByRole('tab');
    expect(tabs[0].getAttribute('aria-label')).toBe('Favourites');
    fireEvent.click(tabs[0]);
    expect(screen.getByText('No favourites yet')).toBeTruthy();
  });
  it('shows favourites and toggles a star', () => {
    const props = setup({ favourites: ['kimi/k2'] });
    openPicker();
    fireEvent.click(screen.getByRole('tab', { name: 'Favourites' }));
    expect(optionNames().join('|')).toContain('Kimi K2');
    fireEvent.click(screen.getByRole('button', { name: 'Remove Kimi K2 from favourites' }));
    expect(props.onToggleFavourite).toHaveBeenCalledWith('kimi/k2');
  });
  it('adds a favourite from a provider list', () => {
    const props = setup();
    openPicker();
    fireEvent.click(screen.getByRole('button', { name: 'Add Claude Opus to favourites' }));
    expect(props.onToggleFavourite).toHaveBeenCalledWith('claude/opus');
  });
  it('searches across providers and identities, in one list with the same row shape', () => {
    setup();
    openPicker();
    fireEvent.change(search(), { target: { value: 'k' } });
    const list = screen.getByRole('listbox');
    expect(within(list).getByText('Kimi K2')).toBeTruthy();
    // The provider is named for screen readers on every row, not in a group heading.
    expect(within(list).getByRole('option', { name: /Kimi K2, Kimi/ })).toBeTruthy();
    fireEvent.change(search(), { target: { value: 'zzz' } });
    expect(screen.getByText('No models found')).toBeTruthy();
  });
  it('selects with the keyboard and closes', () => {
    const props = setup();
    openPicker();
    // The highlight starts on the selected Claude Sonnet (second row), ArrowUp moves to Claude Opus.
    fireEvent.keyDown(search(), { key: 'ArrowUp' });
    fireEvent.keyDown(search(), { key: 'Enter' });
    expect(props.onChange).toHaveBeenCalledWith('claude/opus');
  });
  it('switches provider with ArrowRight and selects the first row', () => {
    const props = setup();
    openPicker();
    fireEvent.keyDown(search(), { key: 'ArrowRight' });
    expect(optionNames().join('|')).toContain('GPT 5');
    fireEvent.keyDown(search(), { key: 'Enter' });
    expect(props.onChange).toHaveBeenCalledWith('codex/gpt-5');
  });
  it('selects by click', () => {
    const props = setup();
    openPicker();
    fireEvent.click(screen.getByRole('option', { name: /Claude Opus/ }));
    expect(props.onChange).toHaveBeenCalledWith('claude/opus');
  });
  it('shows the provider empty state', () => {
    setup({ models: [{ id: 'x/y', route: 'x', model: 'y', name: 'Y', provider: 'x', identity: 'Pool' }], value: '' });
    openPicker(/Choose model/);
    expect(screen.queryByText('No models are available for this provider.')).toBeNull();
    expect(screen.getAllByRole('option')).toHaveLength(1);
  });

  describe('list heading', () => {
    it('names the open provider and identity as text, not only in a tooltip', () => {
      setup({ models: MODELS_TWO_IDENTITIES, value: 'claude/sonnet' });
      openPicker();
      const heading = () => document.querySelector('[data-picker-heading]')!.textContent;
      expect(heading()).toBe('Claude \u00b7 Pool');
      fireEvent.click(screen.getByRole('tab', { name: 'Claude \u00b7 Account A' }));
      expect(heading()).toBe('Claude \u00b7 Account A');
      fireEvent.click(screen.getByRole('tab', { name: 'Favourites' }));
      expect(heading()).toBe('Favourites');
      fireEvent.change(search(), { target: { value: 'opus' } });
      expect(heading()).toBe('Search results');
    });
  });

  describe('identities', () => {
    it('shows no identity badge when each provider has one identity', () => {
      setup();
      openPicker();
      expect(screen.getByRole('tab', { name: 'Codex' })).toBeTruthy();
      expect(document.querySelectorAll('[data-picker-rail] [aria-hidden="true"]:not([data-picker-indicator])').length).toBeLessThan(5);
      expect(screen.queryByRole('tab', { name: /Claude · / })).toBeNull();
    });
    it('lists one rail entry per identity and names the identity when a provider has several', () => {
      setup({ models: MODELS_TWO_IDENTITIES });
      openPicker();
      const names = screen.getAllByRole('tab').map(t => t.getAttribute('aria-label'));
      expect(names).toEqual(['Favourites', 'Claude · Pool', 'Codex', 'Kimi', 'Claude · Account A']);
      // The badge carries the initials of the identity.
      expect(screen.getByRole('tab', { name: 'Claude · Account A' }).textContent).toBe('AA');
    });
    it('opens the list of the other identity and selects its model', () => {
      const props = setup({ models: MODELS_TWO_IDENTITIES });
      openPicker();
      fireEvent.click(screen.getByRole('tab', { name: 'Claude · Account A' }));
      expect(optionNames().join('|')).toContain('Claude Opus');
      fireEvent.click(screen.getByRole('option', { name: /Claude Opus, Claude · Account A/ }));
      expect(props.onChange).toHaveBeenCalledWith('claude-pinned/opus');
    });
    it('names the identity on the trigger when the provider has several', () => {
      setup({ models: MODELS_TWO_IDENTITIES, value: 'claude-pinned/opus' });
      expect(screen.getByRole('button', { name: 'Claude Opus, Account A' })).toBeTruthy();
    });
  });
});
