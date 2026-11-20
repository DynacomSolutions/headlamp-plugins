import { WidgetStore } from '../registry';
import { clockWidget } from './ClockWidget';
import { headerWidget } from './HeaderWidget';
import { noteWidget } from './NoteWidget';

export const BUILTIN_WIDGETS = [clockWidget, noteWidget, headerWidget];

export function registerBuiltinWidgets(store: WidgetStore): void {
  for (const w of BUILTIN_WIDGETS) store.registerWidget(w);
}
