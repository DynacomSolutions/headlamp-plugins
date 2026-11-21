/* Dashboard-level filters and saved views. Every value goes to every widget through context. */
import { Icon } from '@iconify/react';
import Autocomplete from '@mui/material/Autocomplete';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import IconButton from '@mui/material/IconButton';
import ListItemText from '@mui/material/ListItemText';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Popover from '@mui/material/Popover';
import TextField from '@mui/material/TextField';
import React from 'react';
import type { DashboardFilters, TimeRange } from '../contract';
import { SavedView, TIME_RANGES } from '../spec/model';

const RANGE_LABELS: Record<TimeRange, string> = {
  '5m': 'Last 5 minutes',
  '15m': 'Last 15 minutes',
  '1h': 'Last hour',
  '6h': 'Last 6 hours',
  '24h': 'Last 24 hours',
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
};

export interface FilterBarProps {
  filters: DashboardFilters;
  onChange: (filters: DashboardFilters) => void;
  namespaceOptions: string[];
  nodeOptions: string[];
  views: SavedView[];
  activeView: string;
  onSelectView: (id: string) => void;
  /** Undefined when the user cannot write: the save and delete actions are hidden. */
  onSaveView?: (name: string) => void;
  onDeleteView?: (id: string) => void;
  onReset: () => void;
  /**
   * Collapse the namespace, node and label selector fields into one "Filters" button that opens
   * them in a popover, for a title bar that has no room for them in the row. The time range and
   * the views stay in the row.
   */
  compact?: boolean;
  /** Less room still: the range and the views button get narrower. */
  tight?: boolean;
}

function LabelSelectorField(props: {
  value: string;
  onCommit: (v: string) => void;
  fullWidth?: boolean;
}): JSX.Element {
  const { value, onCommit, fullWidth } = props;
  // A local draft: the filter applies on Enter or blur, not on each key, so widgets do not refetch
  // per keystroke. The parent gives it `key={value}`, so a committed change resets the draft.
  const [draft, setDraft] = React.useState(value);
  const commit = () => draft !== value && onCommit(draft.trim());
  return (
    <TextField
      size="small"
      label="Label selector"
      placeholder="app=web,tier!=db"
      value={draft}
      onChange={e => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={e => e.key === 'Enter' && commit()}
      sx={fullWidth ? { width: '100%' } : { minWidth: 150 }}
    />
  );
}

export function FilterBar(props: FilterBarProps): JSX.Element {
  const {
    filters,
    onChange,
    namespaceOptions,
    nodeOptions,
    views,
    activeView,
    onSelectView,
    onSaveView,
    onDeleteView,
    onReset,
    compact,
    tight,
  } = props;
  const [menu, setMenu] = React.useState<HTMLElement | null>(null);
  const [pop, setPop] = React.useState<HTMLElement | null>(null);
  const [naming, setNaming] = React.useState(false);
  const [name, setName] = React.useState('');
  const current = views.find(v => v.id === activeView);

  const fieldsNode = (
    <>
      <Autocomplete
        multiple
        freeSolo
        size="small"
        options={namespaceOptions}
        value={filters.namespaces}
        onChange={(_e, v) => onChange({ ...filters, namespaces: v as string[] })}
        renderInput={p => (
          <TextField
            {...p}
            label="Namespaces"
            placeholder={filters.namespaces.length ? '' : 'All'}
          />
        )}
        sx={compact ? { width: '100%' } : { minWidth: 150, maxWidth: 300, flex: '1 1 160px' }}
      />
      <Autocomplete
        multiple
        freeSolo
        size="small"
        options={nodeOptions}
        value={filters.nodes}
        onChange={(_e, v) => onChange({ ...filters, nodes: v as string[] })}
        renderInput={p => (
          <TextField {...p} label="Nodes" placeholder={filters.nodes.length ? '' : 'All'} />
        )}
        sx={compact ? { width: '100%' } : { minWidth: 150, maxWidth: 300, flex: '1 1 160px' }}
      />
      <LabelSelectorField
        key={filters.labelSelector}
        value={filters.labelSelector}
        onCommit={v => onChange({ ...filters, labelSelector: v })}
        fullWidth={compact}
      />
    </>
  );
  const active =
    filters.namespaces.length + filters.nodes.length + (filters.labelSelector.trim() ? 1 : 0);

  return (
    <Box
      role="search"
      aria-label="Dashboard filters"
      sx={{
        display: 'flex',
        flexWrap: compact ? 'nowrap' : 'wrap',
        alignItems: 'center',
        gap: 1,
        minWidth: 0,
      }}
    >
      {compact ? (
        <>
          <Button
            size="small"
            variant="outlined"
            aria-haspopup="dialog"
            data-filters-button
            startIcon={<Icon icon="mdi:filter-variant" width={18} height={18} />}
            endIcon={<Icon icon="mdi:chevron-down" width={18} height={18} />}
            onClick={e => setPop(e.currentTarget)}
            sx={{ flex: 'none', whiteSpace: 'nowrap' }}
          >
            {active ? `Filters (${active})` : 'Filters'}
          </Button>
          <Popover
            anchorEl={pop}
            open={!!pop}
            onClose={() => setPop(null)}
            anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
          >
            <Box
              data-filters-popover
              sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, p: 2, width: 320 }}
            >
              {fieldsNode}
            </Box>
          </Popover>
        </>
      ) : (
        fieldsNode
      )}
      <TextField
        select
        size="small"
        label="Time range"
        value={filters.range}
        onChange={e => onChange({ ...filters, range: e.target.value as TimeRange })}
        sx={{ minWidth: tight ? 124 : compact ? 140 : 150, flex: 'none' }}
      >
        {TIME_RANGES.map(r => (
          <MenuItem key={r} value={r}>
            {RANGE_LABELS[r]}
          </MenuItem>
        ))}
      </TextField>
      <Button
        size="small"
        variant="outlined"
        aria-haspopup="menu"
        startIcon={<Icon icon="mdi:bookmark-outline" width={18} height={18} />}
        endIcon={<Icon icon="mdi:chevron-down" width={18} height={18} />}
        onClick={e => setMenu(e.currentTarget)}
        sx={{ flex: 'none', whiteSpace: 'nowrap', maxWidth: tight ? 120 : 180 }}
      >
        {current ? current.name : 'Views'}
      </Button>
      <Menu anchorEl={menu} open={!!menu} onClose={() => setMenu(null)}>
        {views.length === 0 && <MenuItem disabled>No saved views</MenuItem>}
        {views.map(v => (
          <MenuItem
            key={v.id}
            selected={v.id === activeView}
            onClick={() => {
              onSelectView(v.id);
              setMenu(null);
            }}
          >
            <ListItemText primary={v.name} />
            {onDeleteView && (
              <IconButton
                size="small"
                aria-label={`Delete view ${v.name}`}
                onClick={e => {
                  e.stopPropagation();
                  onDeleteView(v.id);
                  setMenu(null);
                }}
                sx={{ ml: 2 }}
              >
                <Icon icon="mdi:delete-outline" width={16} height={16} />
              </IconButton>
            )}
          </MenuItem>
        ))}
        <MenuItem
          onClick={() => {
            onReset();
            setMenu(null);
          }}
        >
          Reset filters
        </MenuItem>
        {onSaveView && (
          <MenuItem
            onClick={() => {
              setMenu(null);
              setName(current?.name ?? '');
              setNaming(true);
            }}
          >
            Save the current filters as a view…
          </MenuItem>
        )}
      </Menu>
      {naming && (
        <Dialog open onClose={() => setNaming(false)} aria-labelledby="save-view-title">
          <DialogTitle id="save-view-title">Save view</DialogTitle>
          <DialogContent>
            <TextField
              fullWidth
              size="small"
              label="View name"
              helperText="A view with the same name is replaced."
              value={name}
              onChange={e => setName(e.target.value)}
              sx={{ mt: 1, minWidth: 280 }}
            />
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setNaming(false)}>Cancel</Button>
            <Button
              variant="contained"
              disabled={name.trim() === ''}
              onClick={() => {
                onSaveView?.(name.trim());
                setNaming(false);
              }}
            >
              Save
            </Button>
          </DialogActions>
        </Dialog>
      )}
    </Box>
  );
}
