/*
 * Two small cluster reads for the Uptime widget, both through Headlamp's API proxy like the route lists:
 *
 *  - The node addresses (`/api/v1/nodes`): a check that probes a node address groups under the node name.
 *  - The optional icon map, a ConfigMap `uptime-icons` in the namespace `headlamp-dashboards`: each key is a
 *    group name (or the first part of it) and each value is a small `data:image/svg+xml` or `data:image/png`
 *    address. The map needs no Service proxy access, so it works for the Headlamp service account as it is.
 *
 * A read that fails (not installed, not allowed) gives an empty result and the widget goes on without it.
 * Both results are shared by every widget for `CLUSTER_CACHE_MS`.
 */
import { ApiProxy } from '@kinvolk/headlamp-plugin/lib';
import type { NodeAddresses } from './groups';

export const ICON_MAP_NAMESPACE = 'headlamp-dashboards';
export const ICON_MAP_NAME = 'uptime-icons';
/** The largest icon value that is accepted, in characters. */
export const ICON_MAP_VALUE_MAX = 192 * 1024;
export const CLUSTER_CACHE_MS = 60_000;

const DATA_IMAGE = /^data:image\/(?:svg\+xml|png)[;,]/i;

/** The node name of each address in `.status.addresses` (InternalIP, ExternalIP, Hostname excluded). */
export function nodeAddressesFrom(items: unknown): NodeAddresses {
  const out = new Map<string, string>();
  if (!Array.isArray(items)) return out;
  for (const node of items) {
    const name = node?.metadata?.name;
    if (typeof name !== 'string' || !name) continue;
    const addresses = Array.isArray(node?.status?.addresses) ? node.status.addresses : [];
    for (const a of addresses) {
      if ((a?.type === 'InternalIP' || a?.type === 'ExternalIP') && typeof a.address === 'string') {
        out.set(a.address.trim().toLowerCase(), name);
      }
    }
  }
  return out;
}

/** The icon map of a ConfigMap: lower-case group name to a data address. Other values are dropped. */
export function iconMapFrom(configMap: unknown): ReadonlyMap<string, string> {
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

/**
 * The icon of a group from the map: the group name, else the longest map key that starts the name and ends at
 * a `-` or `.`, so the key `app` covers `app-preview` and `app.example.com`. Undefined when nothing fits.
 */
export function mapIconFor(group: string, map: ReadonlyMap<string, string>): string | undefined {
  const name = group.trim().toLowerCase();
  const exact = map.get(name);
  if (exact) return exact;
  let best = '';
  for (const key of map.keys()) {
    if (key.length > best.length && (name.startsWith(`${key}-`) || name.startsWith(`${key}.`)))
      best = key;
  }
  return best ? map.get(best) : undefined;
}

let cached:
  | { at: number; nodes: Promise<NodeAddresses>; icons: Promise<ReadonlyMap<string, string>> }
  | undefined;

/** Forget the cached reads (tests). */
export function clearClusterCache(): void {
  cached = undefined;
}

/** A read that failed for a reason other than "absent" (404) is not kept, so the next refresh tries again. */
function forgetUnless404(e: unknown): void {
  if ((e as { status?: unknown })?.status !== 404) cached = undefined;
}

async function readNodes(): Promise<NodeAddresses> {
  try {
    const body = await ApiProxy.request('/api/v1/nodes', { method: 'GET' });
    return nodeAddressesFrom(body?.items);
  } catch (e) {
    forgetUnless404(e);
    return new Map();
  }
}

async function readIconMap(): Promise<ReadonlyMap<string, string>> {
  try {
    const body = await ApiProxy.request(
      `/api/v1/namespaces/${ICON_MAP_NAMESPACE}/configmaps/${ICON_MAP_NAME}`,
      { method: 'GET' }
    );
    return iconMapFrom(body);
  } catch (e) {
    forgetUnless404(e);
    return new Map();
  }
}

/** The node addresses and the icon map, shared by every widget for a minute. */
export function fetchClusterInfo(now: number = Date.now()): {
  nodes: Promise<NodeAddresses>;
  icons: Promise<ReadonlyMap<string, string>>;
} {
  if (!cached || now - cached.at >= CLUSTER_CACHE_MS) {
    cached = { at: now, nodes: readNodes(), icons: readIconMap() };
  }
  return cached;
}
