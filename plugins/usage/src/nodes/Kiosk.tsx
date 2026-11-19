/*
 * Kiosk view of the dashboard: a fixed overlay over Headlamp's app bar and sidebar, so only the
 * dashboard shows. It has its own scroll and an always visible Exit control in the top right.
 * Entering asks the browser for full screen (that needs a user gesture, so a page booted with
 * ?kiosk=1 shows the overlay without it). Leaving the browser's full screen by any other way
 * (Esc, F11, a system gesture) leaves the kiosk too; being not full screen on boot does not.
 * The screen is a touch screen: no scrollbars, no focus rings or outlines, no hover states.
 * The active state shows as a change of fill, with a short transition. It also shows a clock.
 */
import { Icon } from '@iconify/react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import { createTheme, ThemeProvider, useTheme } from '@mui/material/styles';
import Typography from '@mui/material/Typography';
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

/** Length of the fill transition on a tap (ms). */
export const KIOSK_TRANSITION_MS = 150;

/**
 * Styles for everything inside the kiosk, also for its drawers: no outlines or focus rings, no
 * boxed buttons, no hover (a tap leaves it stuck on a touch screen). A button shows its state by
 * fill and colour, with a short transition. Plain CSS only: no blur, no shadows.
 */
export const kioskQuietSx = {
  WebkitTapHighlightColor: 'transparent',
  '& :focus, & :focus-visible': { outline: 'none' },
  '& .MuiButtonBase-root': {
    outline: 'none',
    transition: `background-color ${KIOSK_TRANSITION_MS}ms, color ${KIOSK_TRANSITION_MS}ms`,
  },
  '& .MuiButtonBase-root.Mui-focusVisible': { outline: 'none', boxShadow: 'none' },
  '& .MuiButton-outlined, & .MuiButton-outlined.Mui-disabled': { border: 0 },
  '& .MuiButton-outlined': { bgcolor: 'action.selected' },
  '& .MuiButton-outlined:hover': { bgcolor: 'action.selected' },
  '& .MuiButton-outlined.Mui-disabled': { bgcolor: 'action.disabledBackground' },
  '& .MuiButton-text:hover, & .MuiButton-text:active': { bgcolor: 'transparent' },
  '& .MuiButton-contained:hover': { bgcolor: 'primary.main' },
  '& .MuiButton-contained.Mui-disabled': { bgcolor: 'action.disabledBackground' },
  '& .MuiToggleButton-root, & .MuiToggleButton-root.Mui-disabled': { border: 0 },
  '& .MuiToggleButtonGroup-root': { gap: 0.5 },
  '& .MuiToggleButtonGroup-grouped': { borderRadius: 1, border: 0, bgcolor: 'action.selected' },
  '& .MuiToggleButton-root:hover': { bgcolor: 'action.selected' },
  '& .MuiToggleButton-root.Mui-selected, & .MuiToggleButton-root.Mui-selected:hover': {
    bgcolor: 'primary.main',
    color: 'primary.contrastText',
  },
  '& .MuiListItemButton-root:hover': { bgcolor: 'transparent' },
  '& .MuiListItemButton-root.Mui-selected, & .MuiListItemButton-root.Mui-selected:hover': {
    bgcolor: 'action.selected',
  },
} as const;

const TIME_STEP_MS = 60_000;

/** Time as HH:mm (24 h) and date as "Thu 19 Nov 2026", in the browser's local time. */
export function formatClock(d: Date): { time: string; date: string } {
  const two = (n: number) => String(n).padStart(2, '0');
  const part = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-GB', o).format(d);
  return {
    time: `${two(d.getHours())}:${two(d.getMinutes())}`,
    date: `${part({ weekday: 'short' })} ${d.getDate()} ${part({
      month: 'short',
    })} ${d.getFullYear()}`,
  };
}

/** The current time, updated on each minute boundary with one timer at a time. */
export function useMinuteClock(): Date {
  const [now, setNow] = React.useState(() => new Date());
  React.useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      const t = new Date();
      setNow(t);
      timer = setTimeout(tick, TIME_STEP_MS - (t.getTime() % TIME_STEP_MS));
    };
    const t = new Date();
    timer = setTimeout(tick, TIME_STEP_MS - (t.getTime() % TIME_STEP_MS));
    return () => clearTimeout(timer);
  }, []);
  return now;
}

/** Large time over the date, for the top right corner. */
export function Clock(): JSX.Element {
  const { time, date } = formatClock(useMinuteClock());
  return (
    <Box data-kiosk-clock sx={{ flex: 'none', textAlign: 'right', lineHeight: 1.1, pl: 1 }}>
      <Typography
        component="div"
        data-clock-time
        sx={{ fontSize: 40, fontWeight: 600, lineHeight: 1 }}
      >
        {time}
      </Typography>
      <Typography component="div" data-clock-date color="text.secondary" sx={{ fontSize: 16 }}>
        {date}
      </Typography>
    </Box>
  );
}

/** Pure black, so an OLED screen switches its pixels off. */
export const KIOSK_BLACK = '#000';

export function KioskOverlay(props: {
  onExit: () => void;
  /** The filters bar, left of the Exit control. Leave it out to place the Exit control yourself. */
  bar?: React.ReactNode;
  /** The content; a function receives the Exit control, to place it in its own top bar. */
  children: React.ReactNode | ((exit: React.ReactNode) => React.ReactNode);
}): JSX.Element {
  const { onExit, bar, children } = props;
  const outer = useTheme();
  const dark = outer.palette.mode === 'dark';
  // In a dark theme everything inside paints black where it used the grey surfaces: the overlay,
  // the centre discs and the arc gaps of the charts. A light theme stays as it is.
  const theme = React.useMemo(
    () =>
      createTheme(outer, {
        // No ripple: a tap changes the fill, with a short transition.
        components: { MuiButtonBase: { defaultProps: { disableRipple: true } } },
        ...(dark ? { palette: { background: { default: KIOSK_BLACK, paper: KIOSK_BLACK } } } : {}),
      }),
    [dark, outer]
  );
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

  const exitButton0 = (
    <Button
      variant="contained"
      onClick={leave}
      aria-label="Exit full screen"
      startIcon={<Icon icon="mdi:fullscreen-exit" width={24} height={24} />}
      sx={{ minHeight: 56, minWidth: 48, fontSize: 16, flex: 'none' }}
    >
      Exit full screen
    </Button>
  );
  // The Exit control and the clock sit together in the top right corner, the clock last.
  const exitButton = (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flex: 'none' }}>
      {exitButton0}
      <Clock />
    </Box>
  );
  const inline = typeof children === 'function';

  return (
    <ThemeProvider theme={theme}>
      <Box
        data-kiosk-overlay
        sx={theme => ({
          position: 'fixed',
          inset: 0,
          // Above Headlamp's app bar and drawer, and above dialogs and tooltips.
          zIndex: theme.zIndex.tooltip + 100,
          bgcolor: 'background.default',
          color: 'text.primary',
          // The layout fits the screen, so nothing scrolls.
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          p: 1.5,
          boxSizing: 'border-box',
          ...kioskQuietSx,
        })}
      >
        {!inline && (
          <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 2, mb: 1 }}>
            <Box sx={{ flex: '1 1 0', minWidth: 0 }}>{bar}</Box>
            {exitButton}
          </Box>
        )}
        <Box sx={{ flex: '1 1 0', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          {typeof children === 'function' ? children(exitButton) : children}
        </Box>
      </Box>
    </ThemeProvider>
  );
}
