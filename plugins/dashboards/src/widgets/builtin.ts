import { WidgetStore } from '../registry';
import { aisAgentsWidget, aisGatewayWidget } from './ais/AisChartWidgets';
import { aisWidget } from './ais/AisWidget';
import { clockWidget } from './ClockWidget';
import { headerWidget } from './HeaderWidget';
import { hoardDetailWidget } from './hoarddb/HoardDetailWidget';
import { hoardSummaryWidget } from './hoarddb/HoardSummaryWidget';
import { hoardWidget } from './hoarddb/HoardWidget';
import { issuesWidget } from './issues/IssuesWidget';
import { k8sReportWidget } from './k8s/K8sReportWidget';
import { NETFLOW_WIDGETS } from './netflow';
import { noteWidget } from './NoteWidget';
import { PANEL_WIDGETS } from './panels';
import { PROMQL_WIDGETS } from './promql';
import { runnersWidget } from './runners/RunnersWidget';

export const BUILTIN_WIDGETS = [clockWidget, noteWidget, headerWidget];

export function registerBuiltinWidgets(store: WidgetStore): void {
  for (const w of BUILTIN_WIDGETS) store.registerWidget(w);
  store.registerWidget(k8sReportWidget);
  store.registerWidget(aisWidget);
  store.registerWidget(issuesWidget);
  store.registerWidget(aisAgentsWidget);
  store.registerWidget(aisGatewayWidget);
  store.registerWidget(runnersWidget);
  store.registerWidget(hoardWidget);
  store.registerWidget(hoardSummaryWidget);
  store.registerWidget(hoardDetailWidget);
  for (const w of PANEL_WIDGETS) store.registerWidget(w);
  for (const w of PROMQL_WIDGETS) store.registerWidget(w);
  for (const w of NETFLOW_WIDGETS) store.registerWidget(w);
}
