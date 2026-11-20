/* Colours for the report on a normal card and on the black kiosk background. */
import { useTheme } from '@mui/material/styles';

export interface ReportColors {
  text: string;
  muted: string;
  line: string;
  surface: string;
  band: string;
  dark: boolean;
  link: string;
}

export function useReportColors(kiosk: boolean): ReportColors {
  const theme = useTheme();
  if (kiosk) {
    return { text: '#f0efec', muted: '#c3c2b7', line: 'rgba(255,255,255,0.16)', surface: '#000000', band: 'rgba(255,255,255,0.08)', dark: true, link: '#8ab4f8' };
  }
  const dark = theme.palette.mode === 'dark';
  return {
    text: theme.palette.text.primary,
    muted: theme.palette.text.secondary,
    line: theme.palette.divider,
    surface: theme.palette.background.paper,
    band: dark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)',
    dark,
    link: theme.palette.primary.main,
  };
}
