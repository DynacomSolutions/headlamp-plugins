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
 * - A path (`/c/{cluster}/uptime`) stays a path. The `{cluster}` placeholder becomes the current cluster.
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
    if (!v.includes(CLUSTER_PLACEHOLDER)) return v;
    const cluster = targets?.base.startsWith('/c/') ? targets.base.slice(3) : '';
    return cluster ? v.split(CLUSTER_PLACEHOLDER).join(cluster) : undefined;
  }
  if (!/^https?:\/\//i.test(v) || !targets) return undefined;
  const tab = [origin.panelId, origin.sourceId].find(id => !!id && targets.tabs.includes(id));
  return tab ? buildPath({ name: targets.dashboard, tab }, targets.base) : undefined;
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
