/*
 * A bottom sheet for a touch screen: a title, a large Done button and a grid of big tap targets.
 * It has no scrollbar (a long list still scrolls by touch) and no outlines. It sits above the
 * kiosk overlay.
 */
import { Icon } from '@iconify/react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Drawer from '@mui/material/Drawer';
import Typography from '@mui/material/Typography';
import React from 'react';
import { kioskQuietSx } from './Kiosk';

export const TOUCH_MIN = 48;

export function TouchSheet(props: {
  open: boolean;
  title: string;
  onClose: () => void;
  /** Extra controls left of Done, for example Clear. */
  actions?: React.ReactNode;
  children: React.ReactNode;
}): JSX.Element {
  const { open, title, onClose, actions, children } = props;
  return (
    <Drawer
      anchor="bottom"
      open={open}
      onClose={onClose}
      transitionDuration={150}
      sx={theme => ({ zIndex: theme.zIndex.tooltip + 200 })}
      PaperProps={{
        elevation: 0,
        sx: {
          ...kioskQuietSx,
          bgcolor: '#161616',
          backgroundImage: 'none',
          maxHeight: '80vh',
          p: 2,
        },
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 2 }}>
        <Typography component="h2" sx={{ fontSize: 24, fontWeight: 600, flex: '1 1 auto' }}>
          {title}
        </Typography>
        {actions}
        <Button
          variant="contained"
          onClick={onClose}
          aria-label={`Close ${title}`}
          startIcon={<Icon icon="mdi:check" width={24} height={24} />}
          sx={{ minHeight: 56, minWidth: TOUCH_MIN, fontSize: 18 }}
        >
          Done
        </Button>
      </Box>
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
          gap: 1,
          overflowY: 'auto',
          scrollbarWidth: 'none',
          '&::-webkit-scrollbar': { display: 'none' },
        }}
      >
        {children}
      </Box>
    </Drawer>
  );
}

/** One large row in a sheet: icon, label and a check when chosen. Chosen shows as fill. */
export function TouchChoice(props: {
  label: string;
  chosen: boolean;
  onToggle: () => void;
  icon?: string;
}): JSX.Element {
  const { label, chosen, onToggle, icon } = props;
  return (
    <Button
      role="option"
      aria-selected={chosen}
      onClick={onToggle}
      startIcon={icon ? <Icon icon={icon} width={24} height={24} /> : undefined}
      endIcon={chosen ? <Icon icon="mdi:check" width={24} height={24} /> : undefined}
      variant={chosen ? 'contained' : 'outlined'}
      sx={{
        minHeight: 56,
        justifyContent: 'flex-start',
        textTransform: 'none',
        fontSize: 18,
        '& .MuiButton-endIcon': { ml: 'auto' },
      }}
    >
      {label}
    </Button>
  );
}
