/*
 * The org and repo icons of the runner list. They come from the icon map that the Uptime widget
 * already uses: the ConfigMap `uptime-icons`, where each key is a name and each value is a small
 * `data:image/svg+xml` or `data:image/png` address. The map needs no Service proxy access. The
 * keys of a ConfigMap cannot hold a slash, so a runner icon uses a dotted key, in lower case:
 *
 *   gh.<org>         the avatar of an org
 *   gh.<org>.<repo>  the own icon of a repo
 *
 * A repo row takes, in this order: its own key, a map key with the repo name (the app icons of the
 * Uptime widget, with the same "key, then key-suffix" match), then the avatar of its org. An org
 * header takes the avatar of its org. With nothing in the map the row has no icon. The widget never
 * draws a made-up logo and never loads an icon from an external host.
 *
 * The map is read like the Uptime widget reads it, and is shared by every widget for a minute. A
 * read that fails gives an empty map and the widget goes on without icons.
 */
import { ApiProxy } from '@kinvolk/headlamp-plugin/lib';
import React from 'react';
import { NO_ORG, UNKNOWN_REPO } from './join';

export const ICON_MAP_NAMESPACE = 'headlamp-dashboards';
export const ICON_MAP_NAME = 'uptime-icons';
/** The largest icon value that is accepted, in characters. */
export const ICON_MAP_VALUE_MAX = 192 * 1024;
export const ICON_CACHE_MS = 60_000;
/** The prefix of the keys that belong to runner groups. */
export const ICON_KEY_PREFIX = 'gh.';

export type IconMap = ReadonlyMap<string, string>;

const DATA_IMAGE = /^data:image\/(?:svg\+xml|png)[;,]/i;

/** The icon map of a ConfigMap: lower-case key to a data address. Other values are dropped. */
export function iconMapFrom(configMap: unknown): IconMap {
  const out = new Map<string, string>();
  const data = (configMap as { data?: unknown } | null)?.data;
  if (!data || typeof data !== 'object') return out;
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (typeof value !== 'string') continue;
    const v = value.trim();
    if (v.length > ICON_MAP_VALUE_MAX || !DATA_IMAGE.test(v)) continue;
    out.set(key.trim().toLowerCase(), v);
  }
  return out;
}

/** The key of an org avatar. */
export const orgIconKey = (org: string): string => `${ICON_KEY_PREFIX}${org.trim().toLowerCase()}`;

/** The key of the own icon of a repo. */
export const repoIconKey = (org: string, repo: string): string =>
  `${orgIconKey(org)}.${repo.trim().toLowerCase()}`;

/**
 * The icon of a name from the map, like the Uptime widget: the name, else the longest key that
 * starts the name and ends at a `-` or `.`. Undefined when nothing fits. A runner key never matches.
 */
export function mapIconFor(name: string, map: IconMap): string | undefined {
  const n = name.trim().toLowerCase();
  if (n === '') return undefined;
  const exact = map.get(n);
  if (exact) return exact;
  let best = '';
  for (const key of map.keys()) {
    if (key.startsWith(ICON_KEY_PREFIX)) continue;
    if (key.length > best.length && (n.startsWith(`${key}-`) || n.startsWith(`${key}.`)))
      best = key;
  }
  return best ? map.get(best) : undefined;
}

/** The avatar of an org, or undefined. The label for a run with no org has none. */
export function orgIconFor(org: string, map: IconMap): string | undefined {
  return org === NO_ORG ? undefined : map.get(orgIconKey(org));
}

/**
 * The icon of a repo row: its own icon, else an app icon with the repo name, else the avatar of its
 * org. The row of a repo that the source does not know has the avatar only.
 */
export function repoIconFor(org: string, repo: string, map: IconMap): string | undefined {
  if (org !== NO_ORG && repo !== UNKNOWN_REPO) {
    const own = map.get(repoIconKey(org, repo)) ?? mapIconFor(repo, map);
    if (own) return own;
  }
  return orgIconFor(org, map);
}

let cached: { at: number; map: Promise<IconMap> } | undefined;

/** Forgets the cached read. Tests use it. */
export function clearIconMapCache(): void {
  cached = undefined;
}

async function readIconMap(): Promise<IconMap> {
  try {
    const body = await ApiProxy.request(
      `/api/v1/namespaces/${ICON_MAP_NAMESPACE}/configmaps/${ICON_MAP_NAME}`,
      { method: 'GET' }
    );
    return iconMapFrom(body);
  } catch (e) {
    // Only "absent" (404) is kept. Any other failure is read again at the next refresh.
    if ((e as { status?: unknown })?.status !== 404) cached = undefined;
    return new Map();
  }
}

/** The icon map, shared by every widget for `ICON_CACHE_MS`. */
export function fetchIconMap(now: number = Date.now()): Promise<IconMap> {
  if (!cached || now - cached.at >= ICON_CACHE_MS) cached = { at: now, map: readIconMap() };
  return cached.map;
}

const EMPTY: IconMap = new Map();

/** The icon map, empty until it is read. */
export function useIconMap(): IconMap {
  const [map, setMap] = React.useState<IconMap>(EMPTY);
  React.useEffect(() => {
    let live = true;
    fetchIconMap().then(m => {
      if (live && m.size > 0) setMap(m);
    });
    return () => {
      live = false;
    };
  }, []);
  return map;
}
