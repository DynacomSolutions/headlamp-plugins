/* A searchable picker for Iconify `mdi:` icons. Any valid `mdi:` name can be typed too. */
import { Icon } from '@iconify/react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import ButtonBase from '@mui/material/ButtonBase';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import React from 'react';
import { isIconName, searchIcons } from '../icons/iconNames';

export function IconPickerDialog(props: {
  value: string;
  onCancel: () => void;
  onPick: (icon: string) => void;
}): JSX.Element {
  const { value, onCancel, onPick } = props;
  const [query, setQuery] = React.useState('');
  const results = React.useMemo(() => searchIcons(query), [query]);
  const typed = query.trim().startsWith('mdi:') ? query.trim() : '';
  return (
    <Dialog open onClose={onCancel} fullWidth maxWidth="sm" aria-labelledby="icon-picker-title">
      <DialogTitle id="icon-picker-title">Choose an icon</DialogTitle>
      <DialogContent>
        <TextField
          fullWidth
          size="small"
          label="Search icons"
          helperText="For example clock, server or chart. You can also type any mdi: name."
          value={query}
          onChange={e => setQuery(e.target.value)}
          sx={{ my: 1 }}
        />
        {typed && isIconName(typed) && !results.includes(typed) && (
          <Button
            startIcon={<Icon icon={typed} width={20} height={20} />}
            onClick={() => onPick(typed)}
          >
            Use {typed}
          </Button>
        )}
        {results.length === 0 && !typed && (
          <Typography variant="body2" color="text.secondary">
            No icon matches.
          </Typography>
        )}
        <Box
          role="listbox"
          aria-label="Icons"
          sx={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(64px, 1fr))',
            gap: 0.5,
            mt: 1,
          }}
        >
          {results.map(name => (
            <ButtonBase
              key={name}
              role="option"
              aria-selected={name === value}
              aria-label={name.slice(4)}
              title={name}
              onClick={() => onPick(name)}
              sx={{
                flexDirection: 'column',
                p: 1,
                borderRadius: 1,
                border: '1px solid',
                borderColor: name === value ? 'primary.main' : 'divider',
                bgcolor: name === value ? 'action.selected' : undefined,
              }}
            >
              <Icon icon={name} width={24} height={24} />
              <Typography variant="caption" noWrap sx={{ maxWidth: '100%', fontSize: 10 }}>
                {name.slice(4)}
              </Typography>
            </ButtonBase>
          ))}
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onCancel}>Cancel</Button>
      </DialogActions>
    </Dialog>
  );
}
