/* The widget palette: a drawer in edit mode that lists every registered widget type by category. */
import { Icon } from '@iconify/react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Drawer from '@mui/material/Drawer';
import IconButton from '@mui/material/IconButton';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import ListSubheader from '@mui/material/ListSubheader';
import MenuItem from '@mui/material/MenuItem';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import React from 'react';
import { WIDGET_CATEGORIES, WidgetDefinition } from '../contract';

/** Group by category in a fixed order (known categories first, then others by name), filtered by a search text. */
export function groupWidgets(
  defs: WidgetDefinition[],
  query: string
): Array<{ category: string; items: WidgetDefinition[] }> {
  const q = query.trim().toLowerCase();
  const shown = q
    ? defs.filter(d =>
        `${d.title} ${d.description ?? ''} ${d.type} ${d.category}`.toLowerCase().includes(q)
      )
    : defs;
  const known = WIDGET_CATEGORIES as ReadonlyArray<string>;
  const cats = [...new Set(shown.map(d => d.category))].sort((a, b) => {
    const ia = known.indexOf(a);
    const ib = known.indexOf(b);
    if (ia >= 0 || ib >= 0) return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
    return a.localeCompare(b);
  });
  return cats.map(category => ({
    category,
    items: shown
      .filter(d => d.category === category)
      .sort((a, b) => a.title.localeCompare(b.title)),
  }));
}

export interface PaletteDrawerProps {
  open: boolean;
  onClose: () => void;
  definitions: WidgetDefinition[];
  sections: Array<{ id: string; title: string }>;
  /** The section a new widget goes into. */
  sectionId: string;
  onSectionChange: (id: string) => void;
  onAdd: (def: WidgetDefinition, sectionId: string) => void;
}

export function PaletteDrawer(props: PaletteDrawerProps): JSX.Element {
  const { open, onClose, definitions, sections, sectionId, onSectionChange, onAdd } = props;
  const [query, setQuery] = React.useState('');
  const [added, setAdded] = React.useState('');
  const groups = React.useMemo(() => groupWidgets(definitions, query), [definitions, query]);
  return (
    <Drawer
      anchor="right"
      open={open}
      onClose={onClose}
      ModalProps={{ keepMounted: false }}
      // Headlamp's top bar sits above the default drawer level and would hide the header of the palette.
      sx={{ zIndex: theme => theme.zIndex.modal }}
    >
      <Box
        role="region"
        aria-label="Widget palette"
        sx={{
          width: 360,
          maxWidth: '100vw',
          p: 2,
          display: 'flex',
          flexDirection: 'column',
          height: '100%',
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'center', mb: 1 }}>
          <Typography variant="h6" component="h2" sx={{ flex: 1 }}>
            Add a widget
          </Typography>
          <IconButton aria-label="Close the palette" onClick={onClose}>
            <Icon icon="mdi:close" width={20} height={20} />
          </IconButton>
        </Box>
        <TextField
          select
          size="small"
          label="Add to section"
          value={sections.some(s => s.id === sectionId) ? sectionId : sections[0]?.id ?? ''}
          onChange={e => onSectionChange(e.target.value)}
          sx={{ mb: 1 }}
        >
          {sections.map(s => (
            <MenuItem key={s.id} value={s.id}>
              {s.title || 'Untitled section'}
            </MenuItem>
          ))}
        </TextField>
        <TextField
          size="small"
          label="Search widgets"
          value={query}
          onChange={e => setQuery(e.target.value)}
          sx={{ mb: 1 }}
        />
        <Typography
          variant="caption"
          color="text.secondary"
          aria-live="polite"
          sx={{ minHeight: 18 }}
        >
          {added && `Added ${added}.`}
        </Typography>
        <Box sx={{ flex: 1, overflowY: 'auto' }}>
          {groups.length === 0 && (
            <Typography variant="body2" color="text.secondary" sx={{ p: 1 }}>
              No widget matches.
            </Typography>
          )}
          {groups.map(g => (
            <List
              key={g.category}
              dense
              subheader={<ListSubheader disableSticky>{g.category}</ListSubheader>}
            >
              {g.items.map(d => (
                <ListItem
                  key={d.type}
                  secondaryAction={
                    <Button
                      size="small"
                      variant="outlined"
                      aria-label={`Add ${d.title}`}
                      onClick={() => {
                        onAdd(d, sectionId);
                        setAdded(d.title);
                      }}
                    >
                      Add
                    </Button>
                  }
                >
                  <ListItemIcon sx={{ minWidth: 36 }}>
                    <Icon icon={d.icon} width={22} height={22} />
                  </ListItemIcon>
                  <ListItemText primary={d.title} secondary={d.description} sx={{ pr: 6 }} />
                </ListItem>
              ))}
            </List>
          ))}
        </Box>
      </Box>
    </Drawer>
  );
}
