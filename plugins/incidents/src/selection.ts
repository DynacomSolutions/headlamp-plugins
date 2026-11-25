/*
 * A tiny shared store for the two dashboard widgets of this plugin. The list widget publishes what
 * the page URL selects: one incident or a group of incidents (see groupChat.ts). The chat widget
 * reads it and talks about it. Both widgets come from this one bundle, so a module-level store is
 * enough. No other plugin reads it.
 */
import React from 'react';
import { sameSelection, SelectedGroup, SelectedIncident, Selection } from './groupChat';

export type { Selection, SelectedGroup, SelectedIncident };

let selected: Selection | null = null;
let chatWidgets = 0;
const listeners = new Set<() => void>();

const emit = () => listeners.forEach(l => l());

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getSelection(): Selection | null {
  return selected;
}

/** The selected incident, or null when nothing or a group is selected. */
export function getSelectedIncident(): SelectedIncident | null {
  return selected?.kind === 'incident' ? selected : null;
}

/** Sets the selection. An equal selection keeps the same object, so nothing rerenders. */
export function setSelection(next: Selection | null): void {
  if (sameSelection(next, selected)) return;
  selected = next;
  emit();
}

/** Selects one incident, which clears a group selection. */
export function selectIncident(next: { id: string; alertName: string } | null): void {
  setSelection(next ? { kind: 'incident', ...next } : null);
}

export function useSelection(): Selection | null {
  return React.useSyncExternalStore(subscribe, getSelection, getSelection);
}

/** A chat widget calls this while it is mounted. The list widget then selects instead of navigating. */
export function registerChatWidget(): () => void {
  chatWidgets += 1;
  emit();
  return () => {
    chatWidgets -= 1;
    emit();
  };
}

export function hasChatWidget(): boolean {
  return chatWidgets > 0;
}

export function useHasChatWidget(): boolean {
  return React.useSyncExternalStore(subscribe, hasChatWidget, hasChatWidget);
}

/* ---------- The URL focus ---------- */

/*
 * The selection lives in the page URL, as path segments after the tab (see groupChat.ts). The
 * Dashboards plugin gives the segments to a widget as `focus` and a way to change them as `setFocus`.
 * An older Dashboards plugin gives neither: the two widgets then share the same focus in memory, so
 * the selection still works, without the URL.
 */
let fallbackFocus: string[] = [];
const NO_FOCUS: string[] = [];

function setFallbackFocus(next: string[] | null): void {
  const value = next && next.length ? next : NO_FOCUS;
  if (value.join('/') === fallbackFocus.join('/')) return;
  fallbackFocus = value;
  emit();
}

export interface FocusProps {
  focus?: string[];
  setFocus?: (segments: string[] | null) => void;
}

/** The focus segments and the setter of a widget: the page URL, or the memory store without it. */
export function useFocus(props: FocusProps): {
  focus: string[];
  setFocus: (segments: string[] | null) => void;
} {
  const own = React.useSyncExternalStore(
    subscribe,
    () => fallbackFocus,
    () => fallbackFocus
  );
  const viaUrl = !!props.setFocus;
  return {
    focus: viaUrl ? props.focus ?? NO_FOCUS : own,
    setFocus: props.setFocus ?? setFallbackFocus,
  };
}

/** Clears the memory focus. A test calls it between cases. */
export function resetFocus(): void {
  setFallbackFocus(null);
}
