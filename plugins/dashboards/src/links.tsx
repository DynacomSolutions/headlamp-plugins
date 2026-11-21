/*
 * Links in widgets stay inside Headlamp. A widget link goes to a Headlamp route only: another
 * dashboard, a dashboard tab, or a Headlamp page of the same app. An address on another host is
 * never a link, in the same tab or in a new one. The app can run as an installed web app with no
 * browser bar, so a link to another host would trap the user there.
 *
 * A source row can carry an `https://` link (for example the AIS console). `resolveLink` maps it to
 * the dashboard tab of the same panel or source when the dashboard has one. When no tab matches,
 * the row has no link.
 */
import React from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { buildPath } from './urlState';

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
 * The Headlamp path for a link, or undefined when the link has no place inside Headlamp.
 * - A path (`/c/{cluster}/nodes`) stays a path. The `{cluster}` placeholder becomes the current cluster.
 *   A path to a page that is also a tab of this dashboard, for example `/c/{cluster}/uptime` on an
 *   uptime row, opens that tab.
 * - An `http` or `https` link maps to the tab that has the id of the panel, or else of the source.
 * - Anything else (`javascript:`, `mailto:`, `//host`) gives undefined.
 */
export function resolveLink(
  raw: unknown,
  targets: LinkTargets | null,
  origin: LinkOrigin = {}
): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const v = raw.trim();
  if (isAppPath(v)) {
    let path = v;
    if (v.includes(CLUSTER_PLACEHOLDER)) {
      const cluster = targets?.base.startsWith('/c/') ? targets.base.slice(3) : '';
      if (!cluster) return undefined;
      path = v.split(CLUSTER_PLACEHOLDER).join(cluster);
    }
    // A link to a Headlamp page that the dashboard has as a tab (the Uptime page, the Incidents
    // page) opens that tab instead, so the user stays on the dashboard.
    const tab = targets && tabOfPage(path, origin, targets.tabs);
    return tab && targets ? buildPath({ name: targets.dashboard, tab }, targets.base) : path;
  }
  if (!/^https?:\/\//i.test(v) || !targets) return undefined;
  const tab = originTab(origin, targets.tabs);
  return tab ? buildPath({ name: targets.dashboard, tab }, targets.base) : undefined;
}

/** The tab with the id of the panel, or else of the source. */
function originTab(origin: LinkOrigin, tabs: ReadonlyArray<string>): string | undefined {
  return [origin.panelId, origin.sourceId].find(id => !!id && tabs.includes(id));
}

/**
 * The tab for a path to a Headlamp page, `/c/<cluster>/<page>` or `/<page>`. The page name must be
 * the id of a tab, and the tab must also be the one of the panel or of the source that holds the
 * link. A link to a page with more path, such as `/c/main/nodes/a`, keeps its path.
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
 * A link that never leaves Headlamp. A value that is not an app path renders as plain text, so an
 * address on another host can never become an anchor.
 */
export function InternalLink(props: {
  to: string | undefined;
  style?: React.CSSProperties;
  children: React.ReactNode;
}): JSX.Element {
  const { to, style, children } = props;
  if (!isAppPath(to)) return <>{children}</>;
  return (
    <RouterLink to={to} style={style}>
      {children}
    </RouterLink>
  );
}
