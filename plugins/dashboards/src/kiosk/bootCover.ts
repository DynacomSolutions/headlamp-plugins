/*
 * A black cover for a kiosk that boots or reloads. Headlamp draws its own app shell (white page, then
 * the side bar and the top bar) before a plugin route has mounted. On a wall screen that shows as a
 * flash after a self reload. The plugin script runs before the shell paints, so it puts a black
 * layer over the page at once, when the address asks for a kiosk in a dark theme. The kiosk removes
 * the layer as soon as it has drawn its first frame (see `removeBootCover`). A timer removes it
 * anyway after `COVER_MAX_MS`, so a page that never reaches the kiosk is never stuck behind it.
 *
 * What it cannot do: Headlamp's own splash from index.html shows before any plugin script runs.
 * Only a change of that file in the Headlamp image can colour it.
 */
export const COVER_ID = 'dashboards-kiosk-boot-cover';
export const COVER_MAX_MS = 20_000;
const BLACK = '#000';

/** True when the address is a dashboard in kiosk mode. */
export function isKioskAddress(loc: Pick<Location, 'pathname' | 'search'>): boolean {
  return /\/dashboards\/[^/]+/.test(loc.pathname) && new URLSearchParams(loc.search).get('kiosk') === '1';
}

/** True when the saved theme is dark, or there is no saved choice and the system is dark. */
export function prefersDark(
  storage: Pick<Storage, 'getItem'> | undefined,
  systemDark: boolean
): boolean {
  let saved: string | null = null;
  try {
    saved = storage?.getItem('headlampThemePreference') ?? null;
  } catch {
    saved = null;
  }
  if (saved === 'dark') return true;
  if (saved === 'light') return false;
  return systemDark;
}

/** Puts the cover over the page when a dark kiosk boots. Returns true when it did. */
export function installBootCover(doc: Document = document, win: Window = window): boolean {
  try {
    if (!isKioskAddress(win.location)) return false;
    const systemDark = !!win.matchMedia?.('(prefers-color-scheme: dark)').matches;
    if (!prefersDark(win.localStorage, systemDark)) return false;
    if (doc.getElementById(COVER_ID)) return true;
    const cover = doc.createElement('div');
    cover.id = COVER_ID;
    cover.setAttribute('aria-hidden', 'true');
    cover.style.cssText = `position:fixed;inset:0;z-index:2147483000;background:${BLACK};pointer-events:none`;
    (doc.body ?? doc.documentElement).appendChild(cover);
    win.setTimeout(() => removeBootCover(doc), COVER_MAX_MS);
    return true;
  } catch {
    return false;
  }
}

/** Takes the cover away. Safe to call when there is none. */
export function removeBootCover(doc: Document = document): void {
  doc.getElementById(COVER_ID)?.remove();
}
