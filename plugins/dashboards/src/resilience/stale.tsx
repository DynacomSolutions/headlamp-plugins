/*
 * "Stale since 17:56": a widget that keeps its last good data while its source fails reports the
 * time of that data. The widget frame shows it as a small note in the card. A widget reports through
 * `useReportStale`, so the frame (and only the frame) rerenders.
 */
import Typography from '@mui/material/Typography';
import React from 'react';
import { clockTime } from '../refreshStore';

type Report = (since: number | undefined) => void;
export const StaleContext = React.createContext<Report | null>(null);

/** Tell the widget frame that the data is stale since `since` (epoch ms), or fresh (undefined). */
export function useReportStale(since: number | undefined): void {
  const report = React.useContext(StaleContext);
  React.useEffect(() => {
    report?.(since);
    return () => report?.(undefined);
  }, [report, since]);
}

export function StaleMarker({ since }: { since: number }): JSX.Element {
  return (
    <Typography
      variant="caption"
      color="text.secondary"
      data-stale-since={since}
      title="The source does not answer. This is the last good data."
      sx={{ whiteSpace: 'nowrap', flex: 'none', ml: 1 }}
    >
      Stale since {clockTime(since).slice(0, 5)}
    </Typography>
  );
}
