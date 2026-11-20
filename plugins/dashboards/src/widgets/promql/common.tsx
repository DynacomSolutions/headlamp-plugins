/* Pieces the PromQL widgets share: theme ink, a status line, and the settings form helpers. */
import { Icon } from '@iconify/react';
import Box from '@mui/material/Box';
import { useTheme } from '@mui/material/styles';
import Typography from '@mui/material/Typography';
import React from 'react';
import { ColourBook, INK, Ink, KIOSK_INK, Mode } from './palette';

export function useInk(kiosk: boolean): { ink: Ink; mode: Mode } {
  const theme = useTheme();
  const mode: Mode = theme.palette.mode === 'dark' ? 'dark' : 'light';
  return { ink: kiosk ? KIOSK_INK : INK[mode], mode: kiosk ? 'dark' : mode };
}

/** A colour for each key that stays with the key while the widget lives. */
export function useColourBook(): ColourBook {
  const ref = React.useRef<ColourBook>();
  if (!ref.current) ref.current = new ColourBook();
  return ref.current;
}

/** A centred message in the card: an error, a wait or "no data". */
export function Notice(props: { kind: 'error' | 'empty' | 'wait'; children: React.ReactNode }): JSX.Element {
  const icon = props.kind === 'error' ? 'mdi:alert-circle-outline' : props.kind === 'wait' ? 'mdi:timer-sand' : 'mdi:chart-line';
  return (
    <Box
      role={props.kind === 'error' ? 'alert' : 'status'}
      sx={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 1, textAlign: 'center', p: 1, color: 'text.secondary' }}
    >
      <Icon icon={icon} width={20} height={20} />
      <Typography variant="body2" component="span" sx={{ overflowWrap: 'anywhere' }}>
        {props.children}
      </Typography>
    </Box>
  );
}

/** Style that keeps the kiosk quiet: no focus ring, no scrollbar. */
export const kioskBox = (kiosk: boolean) =>
  kiosk
    ? ({
        '& *:focus, & *:focus-visible': { outline: 'none' },
        scrollbarWidth: 'none',
        '&::-webkit-scrollbar, & *::-webkit-scrollbar': { display: 'none' },
        WebkitTapHighlightColor: 'transparent',
      } as const)
    : {};
