/*
 * Old settings key names. Settings that a user or a deployment saved under an old key keep working:
 * the new key wins, and the old key fills in when the new one is empty. This map is the only place
 * that spells the old names. Nothing else reads or writes them.
 */
export const LEGACY_KEYS: Record<string, string> = {
  runwardenMode: 'poolMode',
  runwardenNamespace: 'poolNamespace',
  runwardenService: 'poolService',
  runwardenPort: 'poolPort',
};

/** Returns a copy with each value of an old key moved to its new key. Old keys are dropped. */
export function migrateKeys<T extends object>(cfg: T): T {
  const out = { ...cfg } as Record<string, unknown>;
  for (const [oldKey, newKey] of Object.entries(LEGACY_KEYS)) {
    if (!(oldKey in out)) continue;
    if (!out[newKey] && out[oldKey]) out[newKey] = out[oldKey];
    delete out[oldKey];
  }
  return out as T;
}
