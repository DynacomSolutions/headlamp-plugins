import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import TextField from '@mui/material/TextField';
import React from 'react';

export function DashboardSettingsDialog(props: {
  title: string;
  description: string;
  onCancel: () => void;
  onApply: (title: string, description: string) => void;
}): JSX.Element {
  const [title, setTitle] = React.useState(props.title);
  const [description, setDescription] = React.useState(props.description);
  return (
    <Dialog open onClose={props.onCancel} fullWidth maxWidth="sm" aria-labelledby="dash-settings-title">
      <DialogTitle id="dash-settings-title">Dashboard settings</DialogTitle>
      <DialogContent>
        <TextField fullWidth size="small" label="Title" value={title} onChange={e => setTitle(e.target.value)} sx={{ mt: 1, mb: 2 }} />
        <TextField fullWidth size="small" multiline minRows={2} label="Description" value={description} onChange={e => setDescription(e.target.value)} />
      </DialogContent>
      <DialogActions>
        <Button onClick={props.onCancel}>Cancel</Button>
        <Button variant="contained" disabled={title.trim() === ''} onClick={() => props.onApply(title.trim(), description.trim())}>
          Apply
        </Button>
      </DialogActions>
    </Dialog>
  );
}
