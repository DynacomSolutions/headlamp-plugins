/// <reference types="@kinvolk/headlamp-plugin" />
/*
 * uptime: multi-site uptime checks (blackbox_exporter probes) from a
 * Prometheus-compatible metrics service. Adds an "Uptime" sidebar entry and
 * the /uptime route, and registers the `uptime.targets`
 * widget with the Dashboards plugin.
 */
import './dashboardWidgets';
import { registerRoute, registerSidebarEntry } from '@kinvolk/headlamp-plugin/lib';
import { UptimePage } from './UptimePage';

registerSidebarEntry({
  parent: null,
  name: 'uptime',
  label: 'Uptime',
  url: '/uptime',
  icon: 'mdi:heart-pulse',
});

registerRoute({
  path: '/uptime',
  sidebar: 'uptime',
  name: 'uptime',
  exact: true,
  component: UptimePage,
});
