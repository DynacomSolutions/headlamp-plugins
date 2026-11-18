/*
 * Registers the bundled icons with Iconify, so `<Icon icon="simple-icons:git" />` is drawn from
 * the plugin itself and never fetched from api.iconify.design. Imported once, by the entry point.
 */
import { addCollection } from '@iconify/react';
import { BUNDLED_ICONS } from './bundledIcons.generated';

for (const [prefix, icons] of Object.entries(BUNDLED_ICONS)) {
  addCollection({
    prefix,
    width: 24,
    height: 24,
    icons: Object.fromEntries(Object.entries(icons).map(([name, body]) => [name, { body }])),
  });
}
