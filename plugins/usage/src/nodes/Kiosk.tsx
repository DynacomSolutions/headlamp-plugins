/*
 * Kiosk view of the dashboard: a fixed overlay over Headlamp's app bar and sidebar, so only the
 * dashboard shows. It has its own scroll and an always visible Exit control in the top right.
 * Entering asks the browser for full screen (that needs a user gesture, so a page booted with
 * ?kiosk=1 shows the overlay without it). Leaving the browser's full screen by any other way
 * (Esc, F11, a system gesture) leaves the kiosk too; being not full screen on boot does not.
 */
import { Icon } from '@iconify/react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import React from 'react';

/** Asks the browser for full screen, where it can; a refusal is ignored. */
export function enterBrowserFullscreen(): void {
  const el = document.documentElement;
  if (typeof el.requestFullscreen !== 'function') return;
  try {
    Promise.resolve(el.requestFullscreen()).catch(() => undefined);
  } catch {
    // Not allowed here: the overlay still works without it.
  }
}

/** Leaves the browser's full screen when the document is in it. */
export function exitBrowserFullscreen(): void {
  if (!document.fullscreenElement || typeof document.exitFullscreen !== 'function') return;
  try {
    Promise.resolve(document.exitFullscreen()).catch(() => undefined);
  } catch {
    // Already out.
  }
}

export function KioskOverlay(props: {
  onExit: () => void;
  /** The filters bar, left of the Exit control. */
  bar: React.ReactNode;
  children: React.ReactNode;
}): JSX.Element {
  const { onExit, bar, children } = props;
  const exit = React.useRef(onExit);
  exit.current = onExit;

  React.useEffect(() => {
    // Only a real full screen to not full screen change leaves the kiosk.
    let wasFullscreen = !!document.fullscreenElement;
    const onChange = () => {
      const now = !!document.fullscreenElement;
      if (wasFullscreen && !now) exit.current();
      wasFullscreen = now;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        exitBrowserFullscreen();
        exit.current();
      }
    };
    document.addEventListener('fullscreenchange', onChange);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('fullscreenchange', onChange);
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  const leave = () => {
    exitBrowserFullscreen();
    onExit();
  };

  return (
    <Box
      data-kiosk-overlay
      sx={theme => ({
        position: 'fixed',
        inset: 0,
        // Above Headlamp's app bar and drawer, and above dialogs and tooltips.
        zIndex: theme.zIndex.tooltip + 100,
        bgcolor: 'background.default',
        color: 'text.primary',
        overflow: 'auto',
        display: 'flex',
        flexDirection: 'column',
        p: 1.5,
        boxSizing: 'border-box',
      })}
    >
      <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 2, mb: 1 }}>
        <Box sx={{ flex: '1 1 0', minWidth: 0 }}>{bar}</Box>
        <Button
          variant="contained"
          onClick={leave}
          aria-label="Exit full screen"
          startIcon={<Icon icon="mdi:fullscreen-exit" width={24} height={24} />}
          sx={{ minHeight: 56, minWidth: 48, fontSize: 16, flex: 'none' }}
        >
          Exit full screen
        </Button>
      </Box>
      <Box sx={{ flex: '1 1 0', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {children}
      </Box>
    </Box>
  );
}
