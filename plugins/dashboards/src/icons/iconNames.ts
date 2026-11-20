import { BUNDLED_MDI } from './bundledIcons.generated';

/** Every icon name in the picker, as `mdi:<name>`, sorted. */
export const ICON_NAMES: string[] = Object.keys(BUNDLED_MDI)
  .sort()
  .map(n => `mdi:${n}`);

/** Names matching a search text. Every word must appear in the name. At most `limit`. */
export function searchIcons(query: string, limit = 120, names: string[] = ICON_NAMES): string[] {
  const words = query
    .toLowerCase()
    .replace(/^mdi:/, '')
    .split(/[\s-]+/)
    .filter(Boolean);
  if (words.length === 0) return names.slice(0, limit);
  return names.filter(n => words.every(w => n.includes(w))).slice(0, limit);
}

/** `mdi:` followed by lower case words and dashes. The picker accepts any such name. */
export const isIconName = (s: string): boolean => /^mdi:[a-z0-9]+(-[a-z0-9]+)*$/.test(s);

/** True for an `mdi:` name that the plugin bundles. Any other name would make the browser call the public Iconify API. */
export const isBundledIcon = (s: unknown): s is string =>
  typeof s === 'string' &&
  s.startsWith('mdi:') &&
  Object.prototype.hasOwnProperty.call(BUNDLED_MDI, s.slice(4));
