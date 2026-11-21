/* Severity marks: a shape and a word, never colour alone. Square is critical, triangle is warning, ring is other. */
import { useTheme } from '@mui/material/styles';
import React from 'react';

export type SeverityGroup = 'critical' | 'warning' | 'other';

export const SEVERITY_WORD: Record<SeverityGroup, string> = {
  critical: 'Critical',
  warning: 'Warning',
  other: 'Other',
};

export function useSeverityColours(): Record<SeverityGroup, string> {
  const t = useTheme();
  // Fixed hues, like the dashboard panels: the kiosk theme draws the theme colours in near white.
  const dark = t.palette.mode === 'dark';
  return {
    critical: dark ? '#f44336' : '#d32f2f',
    warning: dark ? '#ffa726' : '#c75b00',
    other: t.palette.text.secondary,
  };
}

export function SeverityMark(props: { severity: SeverityGroup; size?: number }): JSX.Element {
  const colours = useSeverityColours();
  const { severity, size = 14 } = props;
  const c = colours[severity];
  return (
    <svg
      role="img"
      aria-label={SEVERITY_WORD[severity]}
      width={size}
      height={size}
      viewBox="0 0 12 12"
      data-severity={severity}
      style={{ flex: 'none' }}
    >
      {severity === 'critical' && <rect x="1.5" y="1.5" width="9" height="9" rx="1" fill={c} />}
      {severity === 'warning' && <path d="M6 1 L11 11 L1 11 Z" fill={c} />}
      {severity === 'other' && (
        <circle cx="6" cy="6" r="4" fill="none" stroke={c} strokeWidth="2" />
      )}
    </svg>
  );
}
