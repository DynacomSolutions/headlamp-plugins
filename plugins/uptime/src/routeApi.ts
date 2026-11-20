/*
 * Lists the route objects that tell which namespace serves a host: Gateway API HTTPRoutes, Ingresses and
 * Emissary Mappings. One list request per kind, for the whole cluster, through Headlamp's API proxy (the
 * same client the metrics calls use). A kind that is not installed (404) or not readable (403) is an empty
 * list, so a cluster with only one kind still works. The caller makes these requests once per refresh.
 */
import { ApiProxy } from '@kinvolk/headlamp-plugin/lib';
import type { RawRoutes } from './routes';

export const ROUTE_LISTS = {
  httproutes: '/apis/gateway.networking.k8s.io/v1/httproutes',
  ingresses: '/apis/networking.k8s.io/v1/ingresses',
  mappings: '/apis/getambassador.io/v3alpha1/mappings',
} as const;

export interface RouteLists {
  routes: RawRoutes;
  /** The kinds that failed for a reason other than "absent", with the message. Empty when all is well. */
  errors: string[];
}

function statusOf(e: unknown): number | undefined {
  const s = (e as { status?: unknown })?.status;
  return typeof s === 'number' ? s : undefined;
}

async function list(kind: keyof typeof ROUTE_LISTS): Promise<{ items: unknown[]; error?: string }> {
  try {
    const body = await ApiProxy.request(ROUTE_LISTS[kind], { method: 'GET' });
    return { items: Array.isArray(body?.items) ? body.items : [] };
  } catch (e) {
    const status = statusOf(e);
    if (status === 404) return { items: [] };
    return { items: [], error: `${kind}: ${status === 403 ? 'not allowed' : String((e as Error)?.message || e)}` };
  }
}

/** Widgets that refresh together (one dashboard signal) share one set of lists for this long. */
export const ROUTE_CACHE_MS = 5_000;

let cached: { at: number; promise: Promise<RouteLists> } | undefined;

/** Forget the cached lists (tests). */
export function clearRouteCache(): void {
  cached = undefined;
}

/**
 * The three route lists, fetched in parallel. Several widgets on one dashboard refresh on the same
 * signal, so a call within `ROUTE_CACHE_MS` of the last one reuses its result, and a refresh makes one
 * set of requests however many widgets there are. A failed set is not kept.
 */
export function fetchRouteLists(now: number = Date.now()): Promise<RouteLists> {
  if (cached && now - cached.at < ROUTE_CACHE_MS) return cached.promise;
  const promise = loadRouteLists();
  const entry = { at: now, promise };
  cached = entry;
  promise.then(
    r => {
      if (r.errors.length > 0 && cached === entry) cached = undefined;
    },
    () => {
      if (cached === entry) cached = undefined;
    }
  );
  return promise;
}

async function loadRouteLists(): Promise<RouteLists> {
  const [httproutes, ingresses, mappings] = await Promise.all([list('httproutes'), list('ingresses'), list('mappings')]);
  return {
    routes: { httproutes: httproutes.items, ingresses: ingresses.items, mappings: mappings.items },
    errors: [httproutes, ingresses, mappings].flatMap(r => (r.error ? [r.error] : [])),
  };
}
