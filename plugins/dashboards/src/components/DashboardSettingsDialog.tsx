import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControlLabel from '@mui/material/FormControlLabel';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import React from 'react';

export function DashboardSettingsDialog(props: {
  title: string;
  description: string;
  kioskShowFilters: boolean;
  onCancel: () => void;
  onApply: (title: string, description: string, kioskShowFilters: boolean) => void;
}): JSX.Element {
  const [title, setTitle] = React.useState(props.title);
  const [description, setDescription] = React.useState(props.description);
  const [kioskShowFilters, setKioskShowFilters] = React.useState(props.kioskShowFilters);
  return (
    <Dialog
      open
      onClose={props.onCancel}
      fullWidth
      maxWidth="sm"
      aria-labelledby="dash-settings-title"
    >
      <DialogTitle id="dash-settings-title">Dashboard settings</DialogTitle>
      <DialogContent>
        <TextField
          fullWidth
          size="small"
          label="Title"
          value={title}
          onChange={e => setTitle(e.target.value)}
          sx={{ mt: 1, mb: 2 }}
        />
        <TextField
          fullWidth
          size="small"
          multiline
          minRows={2}
          label="Description"
          value={description}
          onChange={e => setDescription(e.target.value)}
          sx={{ mb: 1 }}
        />
        <FormControlLabel
          control={
            <Switch
              checked={kioskShowFilters}
              onChange={e => setKioskShowFilters(e.target.checked)}
            />
          }
          label="Show filters in kiosk"
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={props.onCancel}>Cancel</Button>
        <Button
          variant="contained"
          disabled={title.trim() === ''}
          onClick={() => props.onApply(title.trim(), description.trim(), kioskShowFilters)}
        >
          Apply
        </Button>
      </DialogActions>
    </Dialog>
  );
}
