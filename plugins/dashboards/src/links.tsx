/*
 * A link in a dashboard never leaves the dashboard. This is the rule for every widget, in the dashboard
 * view (`/dashboards/<name>`) and in the kiosk view (`?kiosk=1`). A link goes to one of two places:
 * a tab of the same dashboard, or a focus path under it (`/dashboards/<name>/<tab>/<a>/<b>`). Any
 * other path (a Headlamp page, another dashboard) and any address on another host is not a link.
 * It renders as plain text. A link never opens a new tab or window.
 *
 * Why: the app can run as an installed web app with no browser bar, and a wall kiosk runs in full
 * screen. A link that leaves the dashboard traps the user on another page. A link that drops the
 * query also leaves kiosk mode. So a link keeps the current query (kiosk, filters, refresh and the
 * `w.*` widget parameters), see `InternalLink`.
 *
 * A source row can carry an `https://` link (for example the AIS console). `resolveLink` maps it to
 * the dashboard tab of the same panel or source when the dashboard has one. When no tab matches,
 * the row has no link. `scripts/check-dashboard-links.mjs` checks the widget code for this rule.
 */
import React from 'react';
import { Link as RouterLink, useLocation } from 'react-router-dom';
import { buildPath, parseFocus, parsePath, pathBase } from './urlState';

/** Where a link can go on the current dashboard. */
export interface LinkTargets {
  /** The cluster prefix of the route, "/c/<cluster>", or "". */
  base: string;
  /** The dashboard name. */
  dashboard: string;
  /** The tab ids of the dashboard. */
  tabs: ReadonlyArray<string>;
}

/** The panel that a link comes from. A tab with the id of the panel or of the source is the target. */
export interface LinkOrigin {
  panelId?: string;
  sourceId?: string;
}

export const LinkContext = React.createContext<LinkTargets | null>(null);

const CLUSTER_PLACEHOLDER = '{cluster}';

/** A link inside this app: one leading slash, no scheme, no backslash, no control character. */
export function isAppPath(v: unknown): v is string {
  return (
    typeof v === 'string' &&
    v.startsWith('/') &&
    !v.startsWith('//') &&
    !v.includes('\\') &&
    // eslint-disable-next-line no-control-regex
    !/[\u0000-\u001f]/.test(v)
  );
}

/**
 * The path of a link inside the current dashboard, or undefined when the link has no place there.
 * - A path to a Headlamp page that is also a tab of this dashboard, with the id of the panel or
 *   source that holds the link (`/c/{cluster}/uptime` on an uptime row), opens that tab.
 *   The `{cluster}` placeholder becomes the current cluster.
 * - A path of this dashboard (`/dashboards/<name>/<tab>/<focus...>`) stays, without query or hash.
 * - An `http` or `https` link maps to the tab that has the id of the panel, or else of the source.
 * - Anything else gives undefined: another Headlamp page, another dashboard, `javascript:`,
 *   `mailto:`, `//host`, an address on another host.
 */
export function resolveLink(
  raw: unknown,
  targets: LinkTargets | null,
  origin: LinkOrigin = {}
): string | undefined {
  if (typeof raw !== 'string' || !targets) return undefined;
  const v = raw.trim();
  if (isAppPath(v)) {
    let path = v;
    if (v.includes(CLUSTER_PLACEHOLDER)) {
      const cluster = targets.base.startsWith('/c/') ? targets.base.slice(3) : '';
      if (!cluster) return undefined;
      path = v.split(CLUSTER_PLACEHOLDER).join(cluster);
    }
    const tab = tabOfPage(path, origin, targets.tabs);
    if (tab) return buildPath({ name: targets.dashboard, tab }, targets.base);
    return ownDashboardPath(path, targets);
  }
  if (!/^https?:\/\//i.test(v)) return undefined;
  const tab = originTab(origin, targets.tabs);
  return tab ? buildPath({ name: targets.dashboard, tab }, targets.base) : undefined;
}

/**
 * The path as the dashboard writes it, when it names this dashboard: a known tab (or no tab) and
 * any focus segments. The cluster prefix is the one of the current route. Query and hash are dropped.
 */
function ownDashboardPath(path: string, targets: LinkTargets): string | undefined {
  const pathname = path.split(/[?#]/)[0];
  const base = pathBase(pathname);
  if (base !== '' && base !== targets.base) return undefined;
  const bare = base ? pathname.slice(base.length) : pathname;
  if (bare !== '/dashboards' && !bare.startsWith('/dashboards/')) return undefined;
  const { name, tab } = parsePath(pathname);
  if (name !== targets.dashboard) return undefined;
  if (tab && !targets.tabs.includes(tab)) return undefined;
  return buildPath({ name, tab, focus: parseFocus(pathname) }, targets.base);
}

/** The tab with the id of the panel, or else of the source. */
function originTab(origin: LinkOrigin, tabs: ReadonlyArray<string>): string | undefined {
  return [origin.panelId, origin.sourceId].find(id => !!id && tabs.includes(id));
}

/**
 * The tab for a path to a Headlamp page, `/c/<cluster>/<page>` or `/<page>`. The page name must be
 * the id of a tab, and the tab must also be the one of the panel or of the source that holds the
 * link. A link to a page with more path, such as `/c/main/nodes/a`, is not a tab link.
 */
function tabOfPage(
  path: string,
  origin: LinkOrigin,
  tabs: ReadonlyArray<string>
): string | undefined {
  const parts = path.split(/[?#]/)[0].split('/').filter(Boolean);
  const page = parts[0] === 'c' ? parts.slice(2) : parts;
  if (page.length !== 1) return undefined;
  const tab = originTab(origin, tabs);
  return tab !== undefined && tab === page[0] ? tab : undefined;
}

/** `resolveLink` with the targets of the dashboard that is on screen. */
export function useResolveLink(): (raw: unknown, origin?: LinkOrigin) => string | undefined {
  const targets = React.useContext(LinkContext);
  return React.useCallback(
    (raw: unknown, origin?: LinkOrigin) => resolveLink(raw, targets, origin),
    [targets]
  );
}

/**
 * A link that never leaves the dashboard. A value that is not an app path renders as plain text, so
 * an address on another host can never become an anchor. The link keeps the current query string
 * (kiosk, filters, refresh, widget parameters), so a click never exits kiosk or full screen mode.
 * A `to` that has its own query keeps it.
 */
export function InternalLink(props: {
  to: string | undefined;
  style?: React.CSSProperties;
  children: React.ReactNode;
}): JSX.Element {
  const { to, style, children } = props;
  const { search } = useLocation();
  if (!isAppPath(to)) return <>{children}</>;
  return (
    <RouterLink to={to.includes('?') ? to : { pathname: to, search }} style={style}>
      {children}
    </RouterLink>
  );
}
