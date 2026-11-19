/*
 * The dashboard filters: which nodes and which categories the two charts show. Nothing selected
 * means all. Touch sized (the inputs are 56 px tall, text is 16 px). The state is in the URL.
 */
import { Icon } from '@iconify/react';
import Autocomplete from '@mui/material/Autocomplete';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import React from 'react';
import { TOUCH_MIN, TouchChoice, TouchSheet } from './TouchSheet';
import { CATEGORIES } from './tree';

/** The text of a filter button: All, the one name, or a count. */
export function summary(chosen: string[], label: (id: string) => string): string {
  if (chosen.length === 0) return 'All';
  if (chosen.length === 1) return label(chosen[0]);
  return `${chosen.length} chosen`;
}

/** One filter as a large button with an icon that opens a touch sheet. Nothing chosen means all. */
function TouchFilter(props: {
  title: string;
  icon: string;
  options: string[];
  chosen: string[];
  label: (id: string) => string;
  onChange: (chosen: string[]) => void;
}): JSX.Element {
  const { title, icon, options, chosen, label, onChange } = props;
  const [open, setOpen] = React.useState(false);
  const toggle = (id: string) =>
    onChange(chosen.includes(id) ? chosen.filter(c => c !== id) : [...chosen, id]);
  return (
    <>
      <Button
        variant="outlined"
        aria-label={`${title} filter: ${summary(chosen, label)}`}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
        startIcon={<Icon icon={icon} width={24} height={24} />}
        sx={{
          minHeight: 56,
          minWidth: TOUCH_MIN,
          fontSize: 16,
          textTransform: 'none',
          flex: 'none',
        }}
      >
        {title}: {summary(chosen, label)}
      </Button>
      <TouchSheet
        open={open}
        title={title}
        onClose={() => setOpen(false)}
        actions={
          <Button
            variant="outlined"
            disabled={chosen.length === 0}
            onClick={() => onChange([])}
            aria-label={`Show all ${title}`}
            startIcon={<Icon icon="mdi:close-circle-outline" width={24} height={24} />}
            sx={{ minHeight: 56, minWidth: TOUCH_MIN, fontSize: 18 }}
          >
            All
          </Button>
        }
      >
        {options.map(o => (
          <TouchChoice
            key={o}
            label={label(o)}
            chosen={chosen.includes(o)}
            onToggle={() => toggle(o)}
          />
        ))}
      </TouchSheet>
    </>
  );
}

export function Filters(props: {
  nodeOptions: string[];
  nodes: string[];
  cats: string[];
  onNodes: (nodes: string[]) => void;
  onCats: (cats: string[]) => void;
  /** Touch screen: big buttons that open a sheet, instead of text fields with dropdowns. */
  touch?: boolean;
}): JSX.Element {
  const { nodeOptions, nodes, cats, onNodes, onCats, touch = false } = props;
  const labelOf = (id: string) => CATEGORIES.find(c => c.id === id)?.label ?? id;
  if (touch) {
    return (
      <Box
        role="search"
        aria-label="Filters"
        sx={{ display: 'flex', flexWrap: 'wrap', gap: 1.5, flex: 'none' }}
      >
        <TouchFilter
          title="Nodes"
          icon="mdi:server"
          options={Array.from(new Set([...nodeOptions, ...nodes]))}
          chosen={nodes}
          label={id => id}
          onChange={onNodes}
        />
        <TouchFilter
          title="Category"
          icon="mdi:shape-outline"
          options={CATEGORIES.map(c => c.id)}
          chosen={cats}
          label={labelOf}
          onChange={onCats}
        />
      </Box>
    );
  }
  const option = { sx: { minHeight: 48, fontSize: 16 } };
  const field = (label: string, selected: boolean) => (params: object) =>
    (
      <TextField
        {...params}
        label={label}
        placeholder={selected ? undefined : 'All'}
        InputLabelProps={{ sx: { fontSize: 16 } }}
      />
    );
  return (
    <Box
      role="search"
      aria-label="Filters"
      sx={{ display: 'flex', flexWrap: 'wrap', gap: 2, flex: '2 1 560px', minWidth: 0 }}
    >
      <Autocomplete
        multiple
        limitTags={3}
        disableCloseOnSelect
        options={Array.from(new Set([...nodeOptions, ...nodes]))}
        value={nodes}
        onChange={(_, v) => onNodes(v)}
        renderInput={field('Nodes', nodes.length > 0)}
        ListboxProps={option}
        sx={{ minWidth: 240, flex: '1 1 320px', '& .MuiInputBase-root': { fontSize: 16 } }}
      />
      <Autocomplete
        multiple
        limitTags={3}
        disableCloseOnSelect
        options={CATEGORIES.map(c => c.id)}
        getOptionLabel={labelOf}
        // Match the friendly label and the raw id (k8s, t3, ...).
        filterOptions={(opts, st) =>
          opts.filter(o =>
            `${labelOf(o)} ${o}`.toLowerCase().includes(st.inputValue.trim().toLowerCase())
          )
        }
        value={cats}
        onChange={(_, v) => onCats(v)}
        renderInput={field('Category', cats.length > 0)}
        ListboxProps={option}
        sx={{ minWidth: 240, flex: '1 1 320px', '& .MuiInputBase-root': { fontSize: 16 } }}
      />
    </Box>
  );
}
