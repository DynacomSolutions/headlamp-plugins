/* The Kubernetes report widget: a Salesforce style report over any resource kind. */
import React from 'react';
import type { WidgetDefinition, WidgetProps } from '../../contract';
import { DEFAULT_REPORT, normaliseConfig, ReportConfig } from './config';
import { ReportBody } from './ReportBody';
import { ReportSettings } from './ReportSettings';
import { useResources } from './useResources';

function K8sReport({ config, filters, refreshSignal, reportRefreshed, editing, kiosk }: WidgetProps<ReportConfig>): JSX.Element {
  const cfg = React.useMemo(() => normaliseConfig(config), [config]);
  const state = useResources(cfg.source, filters, refreshSignal, reportRefreshed);
  // Namespaces and nodes narrow the rows. The label selector goes to the API server.
  const scope = React.useMemo(() => ({ namespaces: filters.namespaces, nodes: filters.nodes }), [filters.namespaces, filters.nodes]);
  return <ReportBody objects={state.items} config={cfg} scope={scope} kiosk={kiosk} editing={editing} loading={state.loading} error={state.error} />;
}

export const k8sReportWidget: WidgetDefinition<ReportConfig> = {
  type: 'core.k8s-report',
  title: 'Kubernetes report',
  description: 'A report over any resource kind: a table, a summary with totals and a chart, or a matrix.',
  icon: 'mdi:table-large',
  category: 'Kubernetes',
  defaultSize: { w: 8, h: 12 },
  minSize: { w: 3, h: 6 },
  defaultConfig: DEFAULT_REPORT,
  SettingsComponent: ReportSettings,
  Component: K8sReport,
  selfScroll: false,
};
