/* Edit the tabs of a dashboard: label, icon, order, delete, and where the tab bar sits. */
import { Icon } from '@iconify/react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import IconButton from '@mui/material/IconButton';
import TextField from '@mui/material/TextField';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Typography from '@mui/material/Typography';
import React from 'react';
import type { DashboardSpec, TabPosition } from '../spec/model';
import { IconPickerDialog } from './IconPicker';

export interface TabsActions {
  add(): void;
  rename(tabId: string, label: string): void;
  setIcon(tabId: string, icon: string): void;
  move(from: number, to: number): void;
  remove(tabId: string): void;
  setPosition(p: TabPosition): void;
}

export function TabsDialog(props: { spec: DashboardSpec; actions: TabsActions; onClose: () => void }): JSX.Element {
  const { spec, actions, onClose } = props;
  const [pickFor, setPickFor] = React.useState<string | null>(null);
  const picking = spec.tabs.find(t => t.id === pickFor);
  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="sm" aria-labelledby="tabs-title">
      <DialogTitle id="tabs-title">Tabs</DialogTitle>
      <DialogContent>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, my: 1 }}>
          <Typography variant="body2">Tab bar position</Typography>
          <ToggleButtonGroup
            exclusive
            size="small"
            value={spec.tabPosition}
            aria-label="Tab bar position"
            onChange={(_e, v: TabPosition | null) => v && actions.setPosition(v)}
          >
            <ToggleButton value="top">Top</ToggleButton>
            <ToggleButton value="left">Left side</ToggleButton>
          </ToggleButtonGroup>
        </Box>
        {spec.tabs.map((t, i) => (
          <Box key={t.id} sx={{ display: 'flex', alignItems: 'center', gap: 0.5, py: 0.5 }}>
            <IconButton aria-label={`Change the icon of ${t.label}`} onClick={() => setPickFor(t.id)}>
              <Icon icon={t.icon} width={22} height={22} />
            </IconButton>
            <TextField size="small" label="Label" value={t.label} onChange={e => actions.rename(t.id, e.target.value)} sx={{ flex: 1 }} />
            <IconButton aria-label={`Move ${t.label} earlier`} disabled={i === 0} onClick={() => actions.move(i, i - 1)}>
              <Icon icon="mdi:arrow-up" width={18} height={18} />
            </IconButton>
            <IconButton aria-label={`Move ${t.label} later`} disabled={i === spec.tabs.length - 1} onClick={() => actions.move(i, i + 1)}>
              <Icon icon="mdi:arrow-down" width={18} height={18} />
            </IconButton>
            <IconButton aria-label={`Delete ${t.label}`} disabled={spec.tabs.length <= 1} onClick={() => actions.remove(t.id)}>
              <Icon icon="mdi:delete-outline" width={18} height={18} />
            </IconButton>
          </Box>
        ))}
        <Button startIcon={<Icon icon="mdi:plus" width={18} height={18} />} onClick={actions.add} sx={{ mt: 1 }}>
          Add tab
        </Button>
      </DialogContent>
      <DialogActions>
        <Button variant="contained" onClick={onClose}>
          Done
        </Button>
      </DialogActions>
      {picking && (
        <IconPickerDialog
          value={picking.icon}
          onCancel={() => setPickFor(null)}
          onPick={icon => {
            actions.setIcon(picking.id, icon);
            setPickFor(null);
          }}
        />
      )}
    </Dialog>
  );
}
