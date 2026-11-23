/*
 * The time axis above the history strips. It draws the same cells as the strips (one per bucket, with the same
 * gap), so a tick sits on the left edge of a strip cell and lines up with it exactly. A tick has the local clock
 * (`14:00`) or, at a day boundary, the day (`Tue 24`) with a stronger mark. The times are in the browser zone.
 * The ticks follow the width: a narrow strip gets fewer labels (see `axisTicks`).
 */
import Box from '@mui/material/Box';
import React from 'react';
import { type AxisGrid, axisTicks } from './timeAxis';

/** The room that one label needs, in px: `Mon 23` at 11 px is about 36 px, and a gap. */
export const LABEL_ROOM = 56;
export const AXIS_HEIGHT = 18;

/** How many labels fit a strip of this width. */
export const maxTicksFor = (widthPx: number): number =>
  Math.max(2, Math.floor(widthPx / LABEL_ROOM));

/** The width of an element, kept current. 0 until the first measure, and where there is no ResizeObserver. */
export function useWidth(ref: React.RefObject<HTMLElement>): number {
  const [width, setWidth] = React.useState(0);
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    setWidth(el.clientWidth);
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return width;
}

export function TimeAxis(props: AxisGrid & { minWidth?: number | string; timeZone?: string }) {
  const { startSec, stepSec, buckets, minWidth = 64, timeZone } = props;
  const ref = React.useRef<HTMLDivElement>(null);
  const width = useWidth(ref);
  const ticks = React.useMemo(
    () =>
      axisTicks(
        { startSec, stepSec, buckets },
        { maxTicks: width > 0 ? maxTicksFor(width) : 12, timeZone }
      ),
    [startSec, stepSec, buckets, width, timeZone]
  );
  const at = new Map(ticks.map(t => [t.index, t]));
  return (
    <Box
      ref={ref}
      data-uptime-axis=""
      aria-hidden
      sx={{
        display: 'flex',
        gap: '1px',
        height: AXIS_HEIGHT,
        minWidth,
        color: 'text.secondary',
        fontSize: 11,
        lineHeight: 1,
        fontVariantNumeric: 'tabular-nums',
      }}
    >
      {Array.from({ length: buckets }, (_, i) => {
        const tick = at.get(i);
        return (
          <Box key={i} sx={{ flex: '1 1 0', minWidth: '1px', position: 'relative' }}>
            {tick && (
              <>
                <Box
                  data-uptime-tick={tick.day ? 'day' : 'hour'}
                  sx={{
                    position: 'absolute',
                    left: 0,
                    bottom: 0,
                    width: tick.day ? '2px' : '1px',
                    height: tick.day ? 7 : 4,
                    bgcolor: tick.day ? 'text.primary' : 'text.secondary',
                    opacity: tick.day ? 0.7 : 0.5,
                  }}
                />
                <Box
                  component="span"
                  data-uptime-tick-label=""
                  sx={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    // The first labels start at the strip edge, so they are not cut by the cell before it.
                    transform: i < 2 ? 'translateX(3px)' : 'translateX(-50%)',
                    whiteSpace: 'nowrap',
                    fontWeight: tick.day ? 700 : 400,
                    color: tick.day ? 'text.primary' : undefined,
                    pointerEvents: 'none',
                  }}
                >
                  {tick.label}
                </Box>
              </>
            )}
          </Box>
        );
      })}
    </Box>
  );
}
