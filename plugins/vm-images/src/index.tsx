/*
 * vm-images: a Headlamp page for KubeVirt disks, VM images in the registry
 * (read from a catalogue backend through the Kubernetes service proxy) and
 * the pods and VMs that use them.
 */
import {
  registerPluginSettings,
  registerRoute,
  registerSidebarEntry,
} from '@kinvolk/headlamp-plugin/lib';
import { CONFIG_KEY } from './model';
import { VmImagesPage } from './pages';
import { Settings } from './settings';

registerSidebarEntry({
  parent: null,
  name: 'vm-images',
  label: 'VM images',
  url: '/vm-images',
  icon: 'mdi:harddisk',
});

registerRoute({
  path: '/vm-images',
  sidebar: 'vm-images',
  name: 'vm-images',
  exact: true,
  component: VmImagesPage,
});

registerPluginSettings(CONFIG_KEY, Settings, true);
