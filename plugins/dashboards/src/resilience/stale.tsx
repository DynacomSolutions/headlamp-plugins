/*
 * "Stale since 17:56": a widget that keeps its last good data while its source fails reports the
 * time of that data. The widget frame shows it as a small note in the card. A widget reports through
 * `useReportStale`, so the frame (and only the frame) rerenders.
 *
 * "Cached 17:56": a widget that shows data from the browser cache (see cache/lastGood.ts) that is
 * older than the stale limit, and has no fresh answer yet, reports with `cached` set. The note then
 * says "Cached" and goes away at the first fresh answer.
 */
import Typography from '@mui/material/Typography';
import React from 'react';
import { clockTime } from '../refreshStore';

type Report = (since: number | undefined, cached?: boolean) => void;
export const StaleContext = React.createContext<Report | null>(null);

/**
 * Tell the widget frame that the data is stale since `since` (epoch ms), or fresh (undefined).
 * `cached` says that the data comes from the browser cache and a fresh answer is still on its way.
 */
export function useReportStale(since: number | undefined, cached = false): void {
  const report = React.useContext(StaleContext);
  React.useEffect(() => {
    report?.(since, cached);
    return () => report?.(undefined);
  }, [report, since, cached]);
}

/** "17:56" for a time today, "20 Nov 17:56" for an earlier day. */
export function stamp(at: number, now: number = Date.now()): string {
  const d = new Date(at);
  const t = clockTime(at).slice(0, 5);
  const n = new Date(now);
  if (d.toDateString() === n.toDateString()) return t;
  const month = d.toLocaleString('en-GB', { month: 'short' });
  return `${d.getDate()} ${month} ${t}`;
}

export function StaleMarker({
  since,
  cached = false,
}: {
  since: number;
  cached?: boolean;
}): JSX.Element {
  return (
    <Typography
      variant="caption"
      color="text.secondary"
      data-stale-since={since}
      data-stale-cached={cached ? '' : undefined}
      title={
        cached
          ? 'This data comes from the browser cache. A fresh answer is on its way.'
          : 'The source does not answer. This is the last good data.'
      }
      sx={{ whiteSpace: 'nowrap', flex: 'none', ml: 1 }}
    >
      {cached ? `Cached ${stamp(since)}` : `Stale since ${clockTime(since).slice(0, 5)}`}
    </Typography>
  );
}
