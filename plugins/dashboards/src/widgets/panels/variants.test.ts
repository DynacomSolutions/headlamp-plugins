import { describe, expect, it, vi } from 'vitest';

vi.mock('@kinvolk/headlamp-plugin/lib', () => ({ ApiProxy: { request: vi.fn() }, ConfigStore: class {} }));

import { createWidgetStore } from '../../registry';
import { agentSource,blankDraft, draftToSource } from './sources';
import { syncSourceWidgets, variantWidgets } from './variants';

const mine = draftToSource({ ...blankDraft('my-app'), title: 'My app', icon: 'mdi:server', kind: 'url', baseUrl: 'https://my-app.example.com' });

describe('palette entries per source', () => {
  it('adds a panel and a sunburst entry for each extra source, not for the agent', () => {
    const defs = variantWidgets([agentSource(undefined), mine]);
    expect(defs.map(d => d.type)).toEqual(['agent.panel.my-app', 'agent.sunburst.my-app']);
    expect(defs[0]).toMatchObject({ title: 'Panel from My app', icon: 'mdi:server', defaultConfig: { source: 'my-app', panel: '' } });
  });
  it('registers valid widget types and does not register an unchanged entry twice', () => {
    const store = createWidgetStore();
    const spy = vi.spyOn(store, 'registerWidget');
    syncSourceWidgets(store, [mine]);
    syncSourceWidgets(store, [mine]);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(store.get('agent.panel.my-app')?.title).toBe('Panel from My app');
  });
});
