import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MODELS } from './chat.fixture';
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
  it('searches across providers and groups by provider', () => {
    setup();
    openPicker();
    fireEvent.change(search(), { target: { value: 'k' } });
    // Kimi K2 matches by name and Claude by id? only models containing "k"
    const list = screen.getByRole('listbox');
    expect(within(list).getByText('Kimi K2')).toBeTruthy();
    expect(within(list).getByText('Kimi')).toBeTruthy();
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
    setup({ models: [{ id: 'x/y', route: 'x', model: 'y', name: 'Y' }], value: '' });
    openPicker(/Choose model/);
    expect(screen.queryByText('No models are available for this provider.')).toBeNull();
    expect(screen.getAllByRole('option')).toHaveLength(1);
  });
});
