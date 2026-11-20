/*
 * A tiny shared store for the two dashboard widgets of this plugin. The list widget selects an
 * incident. The chat widget reads it and talks about that incident. Both widgets come from this
 * one bundle, so a module-level store is enough. No other plugin reads it.
 */
import React from 'react';

export interface SelectedIncident {
  id: string;
  alertName: string;
}

let selected: SelectedIncident | null = null;
let chatWidgets = 0;
const listeners = new Set<() => void>();

const emit = () => listeners.forEach(l => l());

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getSelectedIncident(): SelectedIncident | null {
  return selected;
}

/** Sets the selection. The same id again keeps the same object, so nothing rerenders. */
export function selectIncident(next: SelectedIncident | null): void {
  if (next?.id === selected?.id && next?.alertName === selected?.alertName) return;
  selected = next;
  emit();
}

export function useSelectedIncident(): SelectedIncident | null {
  return React.useSyncExternalStore(subscribe, getSelectedIncident, getSelectedIncident);
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
