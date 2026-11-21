/* Pieces the PromQL widgets share: theme ink, a status line, and the settings form helpers. */
import { Icon } from '@iconify/react';
import Box from '@mui/material/Box';
import { useTheme } from '@mui/material/styles';
import Typography from '@mui/material/Typography';
import React from 'react';
import { ColourBook, INK, Ink, KIOSK_INK, Mode } from './palette';

/**
 * The kiosk is black only in a dark theme (the overlay copies the Usage kiosk), so the black tuned ink is
 * used only then. A light theme kiosk keeps the light surface and the normal ink.
 */
export function useInk(kiosk: boolean): { ink: Ink; mode: Mode } {
  const theme = useTheme();
  const mode: Mode = theme.palette.mode === 'dark' ? 'dark' : 'light';
  return { ink: kiosk && mode === 'dark' ? KIOSK_INK : INK[mode], mode };
}

/** A colour for each key that stays with the key while the widget lives. */
export function useColourBook(): ColourBook {
  const ref = React.useRef<ColourBook>();
  if (!ref.current) ref.current = new ColourBook();
  return ref.current;
}

/** A centred message in the card: an error, a wait or "no data". */
export function Notice(props: {
  kind: 'error' | 'empty' | 'wait';
  children: React.ReactNode;
}): JSX.Element {
  const icon =
    props.kind === 'error'
      ? 'mdi:alert-circle-outline'
      : props.kind === 'wait'
      ? 'mdi:timer-sand'
      : 'mdi:chart-line';
  return (
    <Box
      role={props.kind === 'error' ? 'alert' : 'status'}
      sx={{
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 1,
        textAlign: 'center',
        p: 1,
        color: 'text.secondary',
      }}
    >
      <Icon icon={icon} width={20} height={20} />
      <Typography variant="body2" component="span" sx={{ overflowWrap: 'anywhere' }}>
        {props.children}
      </Typography>
    </Box>
  );
}

/**
 * A scrolling list shows that there is more: a thin scrollbar that is always visible (also in the
 * kiosk). It scrolls by touch, and the wheel never scrolls the page.
 */
export const thinScroll = {
  overscrollBehavior: 'contain',
  touchAction: 'pan-y',
  WebkitOverflowScrolling: 'touch',
  scrollbarWidth: 'thin',
  scrollbarColor: 'rgba(128,128,128,0.6) transparent',
  '&::-webkit-scrollbar': { width: 6, height: 6 },
  '&::-webkit-scrollbar-thumb': { borderRadius: 3, background: 'rgba(128,128,128,0.6)' },
} as const;

/** Style that keeps the kiosk quiet: no focus ring. The thin scrollbar stays. */
export const kioskBox = (kiosk: boolean) =>
  kiosk
    ? ({
        '& *:focus, & *:focus-visible': { outline: 'none' },
        WebkitTapHighlightColor: 'transparent',
      } as const)
    : {};
