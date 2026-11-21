/// <reference types="@kinvolk/headlamp-plugin" />
/*
 * dashboards: build and view dashboards of widgets, like the Salesforce Lightning App Builder.
 * Adds a "Dashboards" sidebar entry and these routes:
 *   /dashboards                 the list
 *   /dashboards/:name/:tab?     one dashboard, optionally one tab
 * Each dashboard is a ConfigMap. Other plugins add widgets through window.headlampDashboards
 * (see README.md and src/contract.ts).
 */
import './icons/registerIcons';
import {
  registerPluginSettings,
  registerRoute,
  registerSidebarEntry,
} from '@kinvolk/headlamp-plugin/lib';
import { DashboardPage } from './DashboardPage';
import { DashboardsListPage } from './DashboardsListPage';
import { installEdgeBack } from './edgeBack';
import { getRegistry } from './registry';
import { Settings } from './settings';
import { registerBuiltinWidgets } from './widgets/builtin';

// A swipe right from the left edge goes Back on every page (the installed app has no Back button).
installEdgeBack();

// Install the global registry first, so widgets from plugins that loaded earlier are picked up.
registerBuiltinWidgets(getRegistry());

registerSidebarEntry({
  parent: null,
  name: 'dashboards',
  label: 'Dashboards',
  url: '/dashboards',
  icon: 'mdi:view-dashboard-outline',
});

registerRoute({
  path: '/dashboards',
  sidebar: 'dashboards',
  name: 'dashboards',
  exact: true,
  component: DashboardsListPage,
});

registerRoute({
  path: '/dashboards/:name/:tab?',
  sidebar: 'dashboards',
  name: 'dashboard',
  exact: true,
  component: DashboardPage,
  isFullWidth: true,
});

registerPluginSettings('dashboards', Settings, true);
