/*
 * The last good dashboard spec and the last good cluster sources, kept in the browser (see
 * lastGood.ts). A page that opens, or reloads into a new plugin version, draws the dashboard from
 * these at once and asks the cluster in the background. Only the spec text is kept. It goes through
 * the same parser as a fresh one, so a spec that this plugin version cannot read is not used.
 */
import { DATA_KEY, fromConfigMap, StoredDashboard } from '../storage/storage';
import type { LastGoodStore } from './lastGood';

/** The widget id under which a dashboard keeps its own spec. A widget id never starts with `#`. */
export const SPEC_ID = '#spec';
/** The scope for data that every dashboard shares. */
export const SHARED_SCOPE = '_shared';

interface SpecEntry {
  name: string;
  text: string;
}

export const specScope = (namespace: string, name: string): string => `${namespace}/${name}`;

/** The cached dashboard, or undefined. It has no ConfigMap and no resourceVersion: it is read only. */
export function readCachedDashboard(
  store: LastGoodStore,
  namespace: string,
  name: string
): StoredDashboard | undefined {
  const hit = store.read<SpecEntry>(specScope(namespace, name), SPEC_ID);
  const v = hit?.value;
  if (!v || typeof v.text !== 'string' || typeof v.name !== 'string') return undefined;
  const stored = fromConfigMap(
    { metadata: { name: v.name }, data: { [DATA_KEY]: v.text } },
    namespace
  );
  if (stored.error) return undefined;
  return { ...stored, raw: undefined, resourceVersion: '' };
}

/** Keeps the spec of a dashboard that loaded without error. */
export function writeCachedDashboard(store: LastGoodStore, stored: StoredDashboard): void {
  const text = stored.raw?.data?.[DATA_KEY];
  if (stored.error || typeof text !== 'string') return;
  store.write(specScope(stored.namespace, stored.name), SPEC_ID, {
    name: stored.name,
    text,
  } satisfies SpecEntry);
}

/** The text of the cluster sources ConfigMap key, as the cluster gave it. */
export function readCachedSourcesText(store: LastGoodStore, namespace: string): string | undefined {
  const v = store.read<{ text?: unknown }>(SHARED_SCOPE, `sources:${namespace}`)?.value;
  return typeof v?.text === 'string' ? v.text : undefined;
}

export function writeCachedSourcesText(
  store: LastGoodStore,
  namespace: string,
  text: string
): void {
  store.write(SHARED_SCOPE, `sources:${namespace}`, { text });
}
