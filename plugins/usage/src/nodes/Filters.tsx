/*
 * The dashboard filters: which nodes and which categories the two charts show. Nothing selected
 * means all. Touch sized (the inputs are 56 px tall, text is 16 px). The state is in the URL.
 */
import Autocomplete from '@mui/material/Autocomplete';
import Box from '@mui/material/Box';
import TextField from '@mui/material/TextField';
import { CATEGORIES } from './tree';

export function Filters(props: {
  nodeOptions: string[];
  nodes: string[];
  cats: string[];
  onNodes: (nodes: string[]) => void;
  onCats: (cats: string[]) => void;
}): JSX.Element {
  const { nodeOptions, nodes, cats, onNodes, onCats } = props;
  const labelOf = (id: string) => CATEGORIES.find(c => c.id === id)?.label ?? id;
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
