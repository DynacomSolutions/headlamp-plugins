/* The "Refreshed 12 s ago" text, the Refresh button and the interval select of the header. */
import { Icon } from '@iconify/react';
import IconButton from '@mui/material/IconButton';
import MenuItem from '@mui/material/MenuItem';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import React from 'react';
import { useNow } from '../hooks';
import { clockTime, lastRefreshedAt, RefreshStore, relativeTime } from '../refreshStore';
import { REFRESH_OPTIONS } from '../spec/model';

/** Subscribes to the store itself, so a widget report rerenders only this text. */
export function LastRefreshed({ store }: { store: RefreshStore }): JSX.Element {
  const state = React.useSyncExternalStore(store.subscribe, store.getState);
  const now = useNow(1000);
  const at = lastRefreshedAt(state);
  return (
    <Tooltip title={`Last refreshed ${clockTime(at)}`}>
      <Typography
        variant="caption"
        color="text.secondary"
        data-last-refreshed
        sx={{ whiteSpace: 'nowrap' }}
      >
        Refreshed {relativeTime(at, now)}
      </Typography>
    </Tooltip>
  );
}

export function RefreshControls(props: {
  store: RefreshStore;
  seconds: number;
  onSecondsChange: (s: number) => void;
  /** Show the "Refreshed 12 s ago" text. A narrow title bar leaves it out. */
  showText?: boolean;
  /** Show the auto refresh select. The kiosk has none. */
  showAuto?: boolean;
  /** A narrow bar: a smaller auto refresh select. */
  narrow?: boolean;
  /** Size of the refresh icon, in px. */
  iconSize?: number;
}): JSX.Element {
  const {
    store,
    seconds,
    onSecondsChange,
    showText = true,
    showAuto = true,
    narrow,
    iconSize = 22,
  } = props;
  return (
    <>
      {showText && <LastRefreshed store={store} />}
      <Tooltip title="Refresh now">
        <IconButton aria-label="Refresh now" onClick={() => store.trigger()}>
          <Icon icon="mdi:refresh" width={iconSize} height={iconSize} />
        </IconButton>
      </Tooltip>
      {showAuto && (
        <TextField
          select
          size="small"
          label="Auto refresh"
          value={seconds}
          onChange={e => onSecondsChange(Number(e.target.value))}
          sx={{ minWidth: narrow ? 96 : 120, flex: 'none' }}
        >
          {REFRESH_OPTIONS.map(o => (
            <MenuItem key={o.seconds} value={o.seconds}>
              {o.label}
            </MenuItem>
          ))}
        </TextField>
      )}
    </>
  );
}
