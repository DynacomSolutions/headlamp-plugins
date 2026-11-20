/*
 * The page was called Agent memory at /agent-memory. This keeps old links and bookmarks working:
 * it replaces the history entry with the agent-resource route and keeps the query and the hash.
 * Headlamp serves a plugin route under a cluster prefix (/c/<cluster>/agent-memory), so the
 * target is built from the current path: only the last segment changes, the prefix stays.
 */
import { Redirect, useLocation } from 'react-router-dom';

export const ROUTE = '/agent-resource';
export const LEGACY_ROUTE = '/agent-memory';

/** The new path for a legacy path: the trailing /agent-memory segment becomes /agent-resource. */
export function currentRoute(pathname: string): string {
  const path = pathname.replace(/\/+$/, '');
  return path.endsWith(LEGACY_ROUTE)
    ? `${path.slice(0, path.length - LEGACY_ROUTE.length)}${ROUTE}`
    : ROUTE;
}

export function LegacyRedirect(): JSX.Element {
  const { pathname, search, hash } = useLocation();
  return <Redirect to={{ pathname: currentRoute(pathname), search, hash }} />;
}
