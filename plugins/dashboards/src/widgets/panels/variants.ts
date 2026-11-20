/*
 * One palette entry per configured source. Each entry is a widget type of its own
 * (`agent.panel.<source id>`) that shares the component and the settings form of the base
 * widget and only pre-selects the source. The registry has no way to remove a type, so a source
 * that is removed in this session keeps its entry until the page reloads. A saved widget keeps
 * its own `source` setting, so the base type `agent.panel` always works.
 */
import React from 'react';
import type { WidgetDefinition } from '../../contract';
import { getRegistry, WidgetStore } from '../../registry';
import { panelWidget } from './PanelWidget';
import { AGENT_SOURCE_ID, PanelSource } from './sources';
import { readSourcesNow } from './sourcesConfig';
import { sunburstPanelWidget } from './SunburstWidget';

const BASES: Array<{ base: WidgetDefinition<any>; noun: string }> = [
  { base: panelWidget, noun: 'Panel' },
  { base: sunburstPanelWidget, noun: 'Sunburst' },
];

/** The widget definitions of the extra sources. The built-in agent has the base widgets, so it has no extra entry. */
export function variantWidgets(sources: ReadonlyArray<PanelSource>): WidgetDefinition<any>[] {
  const out: WidgetDefinition<any>[] = [];
  for (const s of sources) {
    if (s.id === AGENT_SOURCE_ID) continue;
    for (const { base, noun } of BASES) {
      out.push({
        ...base,
        type: `${base.type}.${s.id}`,
        title: `${noun} from ${s.title}`,
        description: `${noun} from the ${s.title} panel source.`,
        icon: s.icon ?? base.icon,
        defaultConfig: { ...base.defaultConfig, source: s.id, panel: '' },
      });
    }
  }
  return out;
}

const registered = new Map<string, string>();

/** Registers the entries of the sources. An entry that did not change is not registered again. */
export function syncSourceWidgets(store: WidgetStore, sources: ReadonlyArray<PanelSource>): void {
  for (const def of variantWidgets(sources)) {
    const signature = `${def.title}|${def.icon}|${(def.defaultConfig as { source: string }).source}`;
    if (registered.get(def.type) === signature && store.get(def.type)) continue;
    registered.set(def.type, signature);
    store.registerWidget(def);
  }
}

/** Registers the entries for the sources saved right now (at plugin load). */
export function syncSourceWidgetsNow(): void {
  syncSourceWidgets(getRegistry(), readSourcesNow());
}

/** Keeps the palette entries in step with the sources. Use it in a component that is mounted when the sources change. */
export function useSyncSourceWidgets(sources: ReadonlyArray<PanelSource>): void {
  React.useEffect(() => {
    syncSourceWidgets(getRegistry(), sources);
  }, [sources]);
}
