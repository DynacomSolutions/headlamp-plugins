/// <reference types="@kinvolk/headlamp-plugin" />
/*
 * workflows: the check-in of every recurring job of an app. Apps export `<prefix>_workflow_*` series
 * into a Prometheus-compatible service, and CronJobs come from kube-state-metrics. Adds a "Workflows"
 * sidebar entry and the /workflows route, and registers the `workflows.status` widget with the
 * Dashboards plugin.
 */
import './dashboardWidgets';
import { registerPluginSettings, registerRoute, registerSidebarEntry } from '@kinvolk/headlamp-plugin/lib';
import { CONFIG_KEY } from './model';
import { Settings } from './settings';
import { WorkflowsPage } from './WorkflowsPage';

registerSidebarEntry({
  parent: null,
  name: 'workflows',
  label: 'Workflows',
  url: '/workflows',
  icon: 'mdi:timer-sync-outline',
});

registerRoute({
  path: '/workflows',
  sidebar: 'workflows',
  name: 'workflows',
  exact: true,
  component: WorkflowsPage,
});

registerPluginSettings(CONFIG_KEY, Settings, true);
