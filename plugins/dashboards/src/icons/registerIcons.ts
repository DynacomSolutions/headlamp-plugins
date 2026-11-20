/*
 * Registers the bundled Material Design Icons with Iconify, so `<Icon icon="mdi:clock-outline" />`
 * is drawn from the plugin and not fetched from a public API. Any other `mdi:` name still works
 * where the browser can reach the Iconify service.
 */
import { addCollection } from '@iconify/react';
import { BUNDLED_MDI } from './bundledIcons.generated';

addCollection({
  prefix: 'mdi',
  width: 24,
  height: 24,
  icons: Object.fromEntries(Object.entries(BUNDLED_MDI).map(([name, body]) => [name, { body }])),
});
