import { panelWidget } from './PanelWidget';
import { sunburstPanelWidget } from './SunburstWidget';
import { syncSourceWidgetsNow } from './variants';

export const PANEL_WIDGETS = [panelWidget, sunburstPanelWidget];

/**
 * Adds the palette entry of each saved source. The plugin settings may load a little after the
 * plugin, so the sync runs again twice. The settings page syncs on every change too. A failure
 * (no settings store yet) leaves the base widgets, which always work.
 */
function syncSoon(): void {
  try {
    syncSourceWidgetsNow();
  } catch {
    // Nothing to add yet.
  }
}
syncSoon();
if (typeof window !== 'undefined') {
  setTimeout(syncSoon, 2000);
  setTimeout(syncSoon, 10000);
}
