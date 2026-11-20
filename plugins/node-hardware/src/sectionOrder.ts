/*
 * Section ordering for the Node details page. Pure functions, no Headlamp imports,
 * so they can be unit tested with fake section lists.
 *
 * Headlamp (detailsViewSectionSlice.setDetailsViewSection) assigns `id` on the
 * registered object, and that object can already be frozen. So the plugin registers
 * plain functions, which Headlamp wraps in a fresh `{ id, section }` object, and
 * finds its own section by function identity, not by id.
 */
/** Id of Headlamp's built-in main info section (DefaultDetailsViewSection.METADATA). */
export const MAIN_INFO_SECTION_ID = 'METADATA';
/** Id of Headlamp's built-in Node pods section. */
export const PODS_SECTION_ID = 'headlamp.node-owned-pods';

type Wrapped = { id?: unknown; section?: unknown };
const asObject = (s: unknown): Wrapped | undefined => (s && typeof s === 'object' ? (s as Wrapped) : undefined);
const idOf = (s: unknown): unknown => asObject(s)?.id;

/**
 * Moves the section whose `section` is `profileSection` directly before the Pods section.
 * When the pods section is missing, it goes directly after the main info section.
 * Returns the list unchanged (same reference) when the resource is not a Node, the
 * section is not found or neither anchor id is present. Never mutates the input.
 */
export function moveHardwareProfileSection<T>(kind: string | undefined, sections: T[], profileSection: unknown): T[] {
  if (kind !== 'Node') {
    return sections;
  }
  const from = sections.findIndex(s => asObject(s)?.section === profileSection);
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
