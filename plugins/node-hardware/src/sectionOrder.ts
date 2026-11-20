/*
 * Section ordering for the Node details page. Pure functions, no Headlamp imports,
 * so they can be unit tested with fake section lists.
 */
export const HARDWARE_PROFILE_SECTION_ID = 'node-hardware.profile';
export const HARDWARE_SENSORS_SECTION_ID = 'node-hardware.sensors';
/** Id of Headlamp's built-in main info section (DefaultDetailsViewSection.METADATA). */
export const MAIN_INFO_SECTION_ID = 'METADATA';
/** Id of Headlamp's built-in Node pods section. */
export const PODS_SECTION_ID = 'headlamp.node-owned-pods';

type WithId = { id?: unknown };
const idOf = (s: unknown): unknown => (s && typeof s === 'object' ? (s as WithId).id : undefined);

/**
 * Moves the hardware profile section directly before the Pods section. When the pods
 * section is missing, it goes directly after the main info section. Returns the list
 * unchanged when the resource is not a Node or neither anchor id is present.
 */
export function moveHardwareProfileSection<T>(kind: string | undefined, sections: T[]): T[] {
  if (kind !== 'Node') {
    return sections;
  }
  const from = sections.findIndex(s => idOf(s) === HARDWARE_PROFILE_SECTION_ID);
  if (from < 0) {
    return sections;
  }
  const next = [...sections];
  const [profile] = next.splice(from, 1);
  const pods = next.findIndex(s => idOf(s) === PODS_SECTION_ID);
  const main = next.findIndex(s => idOf(s) === MAIN_INFO_SECTION_ID);
  const at = pods >= 0 ? pods : main >= 0 ? main + 1 : -1;
  if (at < 0 || at === from) {
    return sections;
  }
  next.splice(at, 0, profile);
  return next;
}
