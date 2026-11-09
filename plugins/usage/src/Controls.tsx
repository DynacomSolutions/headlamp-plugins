/* Filter and view controls. Stateless: every change goes up as a patch to the URL state. */
import { Icon } from '@iconify/react';
import Autocomplete from '@mui/material/Autocomplete';
import Box from '@mui/material/Box';
import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import TextField from '@mui/material/TextField';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import React from 'react';
import { LABEL_PREFIX } from './model';
import { isRecordedLabel, Range, RANGES, RECORDED_LABEL_KEYS, RECORDED_UNAVAILABLE, ResourceId, RESOURCES } from './resources';
import { UsageState } from './urlState';

export interface ControlsProps {
  /** 7d and 30d read recorded series: no Service or pod grouping, and only the recorded labels. */
  recorded: boolean;
  state: UsageState;
  patch: (p: Partial<UsageState>) => void;
  namespaceOptions: string[];
  nodeOptions: string[];
  groupOptions: string[];
  labelKeyOptions: string[];
}

const GROUP_LABELS: Record<string, string> = {
  namespace: 'Namespace',
  workload: 'Workload',
  service: 'Service',
  node: 'Node',
  pod: 'Pod',
  label: 'Label',
};

function MultiSelect({ label, value, options, onChange }: { label: string; value: string[]; options: string[]; onChange: (v: string[]) => void }) {
  return (
    <Autocomplete
      multiple
      size="small"
      limitTags={2}
      options={Array.from(new Set([...options, ...value]))}
      value={value}
      onChange={(_, v) => onChange(v)}
      renderInput={params => <TextField {...params} label={label} />}
      sx={{ minWidth: 220, flex: '1 1 220px' }}
    />
  );
}

export function Controls({ recorded, state, patch, namespaceOptions, nodeOptions, groupOptions, labelKeyOptions }: ControlsProps): JSX.Element {
  // Recorded ranges offer only the recorded keys; others stay listed but disabled.
  const labelChoices = Array.from(new Set(recorded ? [...RECORDED_LABEL_KEYS, ...labelKeyOptions] : labelKeyOptions));
  const isLabel = state.groupBy.startsWith(LABEL_PREFIX);
  const groupSelect = isLabel ? 'label' : state.groupBy;
  // Group keys belong to one grouping, so changing it resets drill-down and group filters.
  // Service and pod detail exist only in the raw metrics (up to 24h).
  const groupDisabled = (id: string) => (recorded && (id === 'service' || id === 'pod')) || (id === 'label' && labelChoices.length === 0);
  const regroup = (groupBy: string) => patch({ groupBy, drill: [], include: [], exclude: [] });

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, mb: 2 }}>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 2, alignItems: 'center' }}>
        <ToggleButtonGroup
          exclusive
          size="small"
          aria-label="Time range"
          value={state.range}
          onChange={(_, v: Range | null) => v && patch({ range: v })}
        >
          {RANGES.map(r => (
            <ToggleButton
              key={r}
              value={r}
              sx={{
                '&.Mui-selected, &.Mui-selected:hover': { bgcolor: 'primary.main', color: 'primary.contrastText' },
                '&.Mui-selected:hover': { bgcolor: 'primary.dark' },
              }}
            >
              {r}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>

        <FormControl size="small" sx={{ minWidth: 160 }}>
          <InputLabel id="usage-group-label">Group by</InputLabel>
          <Select
            labelId="usage-group-label"
            label="Group by"
            value={groupSelect}
            onChange={e => {
              const v = e.target.value as string;
              if (groupDisabled(v)) {
                return;
              }
              const first = recorded ? RECORDED_LABEL_KEYS[0] : labelKeyOptions.includes('app') ? 'app' : labelKeyOptions[0] ?? '';
              regroup(v === 'label' ? `${LABEL_PREFIX}${first}` : v);
            }}
          >
            {Object.entries(GROUP_LABELS).map(([id, text]) => (
              <MenuItem
                key={id}
                value={id}
                disabled={groupDisabled(id)}
                title={recorded && (id === 'service' || id === 'pod') ? RECORDED_UNAVAILABLE : undefined}
                sx={{ '&.Mui-disabled': { pointerEvents: 'auto' } }}
              >
                {text}
              </MenuItem>
            ))}
          </Select>
        </FormControl>

        {isLabel && (
          <Autocomplete
            size="small"
            disableClearable
            options={Array.from(new Set([...labelChoices, state.groupBy.slice(LABEL_PREFIX.length)]))}
            value={state.groupBy.slice(LABEL_PREFIX.length)}
            getOptionDisabled={o => recorded && !isRecordedLabel(o)}
            renderOption={(props, o) => (
              <li {...props} key={o} title={recorded && !isRecordedLabel(o) ? RECORDED_UNAVAILABLE : undefined} style={recorded && !isRecordedLabel(o) ? { pointerEvents: 'auto' } : undefined}>
                {o}
              </li>
            )}
            onChange={(_, v) => !(recorded && !isRecordedLabel(v)) && regroup(`${LABEL_PREFIX}${v}`)}
            renderInput={params => <TextField {...params} label="Label key" />}
            sx={{ minWidth: 240 }}
          />
        )}

        <ToggleButtonGroup
          size="small"
          aria-label="Resources shown"
          value={state.resources}
          onChange={(_, v: ResourceId[]) => v.length > 0 && patch({ resources: v })}
        >
          {RESOURCES.map(r => (
            <ToggleButton
              key={r.id}
              value={r.id}
              sx={{
                '&.Mui-selected, &.Mui-selected:hover': { bgcolor: 'primary.main', color: 'primary.contrastText' },
                '&.Mui-selected:hover': { bgcolor: 'primary.dark' },
              }}
            >
              {state.resources.includes(r.id) && <Icon icon="mdi:check" width={18} style={{ marginRight: 4 }} />}
              {r.label}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
      </Box>

      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 2 }}>
        <MultiSelect label="Namespaces" value={state.namespaces} options={namespaceOptions} onChange={namespaces => patch({ namespaces })} />
        <MultiSelect label="Nodes (hardware)" value={state.nodes} options={nodeOptions} onChange={nodes => patch({ nodes })} />
        <MultiSelect label="Only include groups" value={state.include} options={groupOptions} onChange={include => patch({ include })} />
        <MultiSelect label="Exclude groups" value={state.exclude} options={groupOptions} onChange={exclude => patch({ exclude })} />
      </Box>
    </Box>
  );
}
