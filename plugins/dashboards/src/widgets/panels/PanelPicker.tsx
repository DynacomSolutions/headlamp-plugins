/* The widget settings fields shared by the panel widgets: pick a source, then a panel from that source. */
import Alert from '@mui/material/Alert';
import MenuItem from '@mui/material/MenuItem';
import TextField from '@mui/material/TextField';
import React from 'react';
import type { WidgetSettingsProps } from '../../contract';
import { usePanelList } from './data';
import { AGENT_SOURCE_ID } from './sources';
import { useSourceLookup, useSources } from './sourcesConfig';

export interface SourcePanelConfig {
  /** The id of the panel source. Saved dashboards without it use the built-in `agent`. */
  source: string;
  /** The panel id, for example `uptime`. Empty until the user picks one. */
  panel: string;
}

export const sourceOf = (config: { source?: unknown }): string =>
  typeof config.source === 'string' && config.source !== '' ? config.source : AGENT_SOURCE_ID;

export function SourcePanelPicker<C extends SourcePanelConfig>({
  config,
  onChange,
}: WidgetSettingsProps<C>): JSX.Element {
  const sources = useSources();
  const sourceId = sourceOf(config);
  const { source, pending } = useSourceLookup(sourceId);
  const list = usePanelList(source, sourceId);
  // A source or panel that is no longer listed stays selectable, so the saved choice is never lost.
  const knownPanel = list.panels.some(p => p.id === config.panel);
  const description = list.panels.find(p => p.id === config.panel)?.description;
  return (
    <>
      <TextField
        select
        size="small"
        label="Source"
        value={sourceId}
        helperText="Where the panels come from. Cluster sources are shared. Add sources of this browser on the Dashboards settings page."
        // Another source has other panels, so the panel choice starts again.
        onChange={e => onChange({ ...config, source: e.target.value, panel: '' })}
      >
        {!source && (
          <MenuItem value={sourceId}>
            {sourceId} ({pending ? 'loading' : 'not configured'})
          </MenuItem>
        )}
        {sources.map(s => (
          <MenuItem key={s.id} value={s.id}>
            {s.title}
          </MenuItem>
        ))}
      </TextField>
      {list.error && <Alert severity="error">Could not list the panels: {list.error}</Alert>}
      <TextField
        select
        size="small"
        label="Panel"
        value={config.panel}
        disabled={list.loading}
        helperText={
          description || (list.loading ? 'Loading the panels.' : 'The source supplies the panels.')
        }
        onChange={e => onChange({ ...config, panel: e.target.value })}
      >
        {!knownPanel && config.panel !== '' && (
          <MenuItem value={config.panel}>{config.panel}</MenuItem>
        )}
        {list.panels.map(p => (
          <MenuItem key={p.id} value={p.id}>
            {p.title}
          </MenuItem>
        ))}
      </TextField>
    </>
  );
}
