/** Network side of the hardware profile: runs every query in inventory.ts. */
import { buildProfiles, HardwareProfile, InventoryData, QUERIES } from './inventory';
import { MetricSample, queryMetrics } from './metrics';

/** Queries every series. A failing query gives an empty list; only when all fail does the fetch throw. */
export async function fetchInventory(): Promise<Map<string, HardwareProfile>> {
  const keys = Object.keys(QUERIES) as (keyof typeof QUERIES)[];
  let failures = 0;
  let firstError: Error | undefined;
  const results = await Promise.all(
    keys.map(k =>
      queryMetrics(QUERIES[k]).catch((err: Error) => {
        failures += 1;
        firstError = firstError ?? err;
        return [] as MetricSample[];
      }),
    ),
  );
  if (failures === keys.length && firstError) {
    throw firstError;
  }
  return buildProfiles(Object.fromEntries(keys.map((k, i) => [k, results[i]])) as InventoryData);
}
