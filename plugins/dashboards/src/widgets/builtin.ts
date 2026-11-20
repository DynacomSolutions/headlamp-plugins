import { WidgetStore } from '../registry';
import { clockWidget } from './ClockWidget';
import { headerWidget } from './HeaderWidget';
import { k8sReportWidget } from './k8s/K8sReportWidget';
import { noteWidget } from './NoteWidget';
import { PANEL_WIDGETS } from './panels';
import { PROMQL_WIDGETS } from './promql';

export const BUILTIN_WIDGETS = [clockWidget, noteWidget, headerWidget];

export function registerBuiltinWidgets(store: WidgetStore): void {
  for (const w of BUILTIN_WIDGETS) store.registerWidget(w);
  store.registerWidget(k8sReportWidget);
  for (const w of PANEL_WIDGETS) store.registerWidget(w);
  for (const w of PROMQL_WIDGETS) store.registerWidget(w);
}
