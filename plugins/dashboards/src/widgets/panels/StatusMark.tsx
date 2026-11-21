/* The status words, colours and marks of a panel. A status is a shape and a word, never colour alone. */
import React from 'react';
import type { PanelStatus } from './model';
import { useTokens } from './tokens';

export const STATUS_WORD: Record<PanelStatus, string> = {
  ok: 'OK',
  warn: 'Warning',
  crit: 'Critical',
  unknown: 'Unknown',
};

/** Status colours (see `STATUS_HUES`). They are reserved for status, never used for a series. */
export function useStatusColours(): Record<PanelStatus, string> {
  return useTokens().status;
}

/** A status mark with its own shape: circle (ok), triangle (warning), square (critical), ring (unknown). */
export function StatusMark(props: { status: PanelStatus; size?: number }): JSX.Element {
  const colours = useStatusColours();
  const { status, size = 12 } = props;
  const c = colours[status];
  return (
    <svg
      role="img"
      aria-label={STATUS_WORD[status]}
      width={size}
      height={size}
      viewBox="0 0 12 12"
      data-status={status}
      style={{ flex: 'none' }}
    >
      {status === 'ok' && <circle cx="6" cy="6" r="5" fill={c} />}
      {status === 'warn' && <path d="M6 1 L11 11 L1 11 Z" fill={c} />}
      {status === 'crit' && <rect x="1.5" y="1.5" width="9" height="9" rx="1" fill={c} />}
      {status === 'unknown' && (
        <circle cx="6" cy="6" r="4" fill="none" stroke={c} strokeWidth="2" />
      )}
    </svg>
  );
}
