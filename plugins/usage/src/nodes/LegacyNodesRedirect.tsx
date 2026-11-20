/*
 * The Nodes page was renamed the Usage dashboard. This keeps old /usage/nodes links and cabinet
 * bookmarks working: it replaces the history entry with the dashboard route and keeps the query
 * and the hash. Headlamp serves a plugin route under a cluster prefix (/c/<cluster>/usage/nodes),
 * so the target is built from the current path: only the last two segments change, the prefix stays.
 */
import { Redirect, useLocation } from 'react-router-dom';

export const DASHBOARD_ROUTE = '/usage/dashboard';
export const LEGACY_NODES_ROUTE = '/usage/nodes';

/** The dashboard path for a legacy path: the trailing /usage/nodes becomes /usage/dashboard. */
export function dashboardPathFor(pathname: string): string {
  const path = pathname.replace(/\/+$/, '');
  return path.endsWith(LEGACY_NODES_ROUTE)
    ? `${path.slice(0, path.length - LEGACY_NODES_ROUTE.length)}${DASHBOARD_ROUTE}`
    : DASHBOARD_ROUTE;
}

export function LegacyNodesRedirect(): JSX.Element {
  const { pathname, search, hash } = useLocation();
  return <Redirect to={{ pathname: dashboardPathFor(pathname), search, hash }} />;
}
