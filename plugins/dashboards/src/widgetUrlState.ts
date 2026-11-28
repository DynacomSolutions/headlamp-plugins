/*
 * The view state of one widget in the page URL, so the URL alone reproduces the view. The state is
 * one text in the query param `w.<widget id>`. The widget decides what the text means. The page
 * keeps the param when it rewrites the query (see `serialiseQuery`).
 *
 * A write uses history replace, so Back does not step through every click. A write reads the
 * query at the moment of the call, so two quick writes never undo each other.
 */
import React from 'react';
import { useHistory, useLocation } from 'react-router-dom';
import { widgetParam } from './urlState';

/** The text of one widget param in a query string. Empty when the param is missing. */
export function readWidgetParam(search: string, instanceId: string, part = ''): string {
  return new URLSearchParams(search).get(widgetParam(instanceId, part)) ?? '';
}

/**
 * The query string (with the leading "?", or "") with one widget param set. An empty value removes
 * the param. Every other param stays as it is.
 */
export function withWidgetParam(
  search: string,
  instanceId: string,
  value: string,
  part = ''
): string {
  const p = new URLSearchParams(search);
  if (value === '') p.delete(widgetParam(instanceId, part));
  else p.set(widgetParam(instanceId, part), value);
  const out = p.toString();
  return out ? `?${out}` : '';
}

/**
 * The state text of a widget in the URL, and a function that writes it with history replace. With
 * no `instanceId` the value is always empty and a write does nothing. `part` names a second value
 * of the same widget: the param is then `w.<widget id>.<part>`.
 */
export function useWidgetUrlState(
  instanceId: string | undefined,
  part = ''
): [string, (value: string) => void] {
  const history = useHistory();
  const location = useLocation();
  const value = instanceId ? readWidgetParam(location.search, instanceId, part) : '';
  const setValue = React.useCallback(
    (next: string) => {
      if (!instanceId) return;
      const now = history.location;
      const search = withWidgetParam(now.search, instanceId, next, part);
      if (search === now.search) return;
      history.replace({ pathname: now.pathname, search, hash: now.hash, state: now.state });
    },
    [history, instanceId, part]
  );
  return [value, setValue];
}
