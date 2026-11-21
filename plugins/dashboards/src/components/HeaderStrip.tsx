/*
 * The widgets of the dashboard header, drawn inline in the title bar. Each widget draws without a
 * card and gets `compact`, so a clock shows the time and the date stacked, at the height of the
 * row. The widgets fall into three parts of the bar, by their order on the header grid: a clock
 * is the centre, the widgets before it (the alert chips) are on the left, right of the title, and
 * the widgets after it are on the right, left of the refresh and full screen buttons. A header
 * with no clock draws all its widgets on the left. Edit mode keeps the header band with its grid,
 * so widgets can still be added, moved, configured and removed there.
 */
import Box from '@mui/material/Box';
import React from 'react';
import type { Band, WidgetInstance } from '../spec/model';
import { bandVisible } from './BandView';
import { FrameActions, WidgetFrame } from './WidgetFrame';

export type HeaderPart = 'left' | 'centre' | 'right';

/** The widget type that sits in the exact middle of the title bar. */
export const CENTRE_WIDGET_TYPE = 'core.clock';

/** The widgets of one part of the bar, in the order of the header grid. */
export function headerWidgets(band: Band, part: HeaderPart): WidgetInstance[] {
  const sorted = [...band.section.widgets].sort((a, b) => a.y - b.y || a.x - b.x);
  const clock = sorted.findIndex(w => w.type === CENTRE_WIDGET_TYPE);
  return sorted.filter((w, i) => {
    if (clock < 0) return part === 'left';
    if (w.type === CENTRE_WIDGET_TYPE) return part === 'centre';
    return i < clock ? part === 'left' : part === 'right';
  });
}

/** The height of the header row, in pixels. The clock and the buttons fit it. */
export const HEADER_ROW_HEIGHT = 48;

export function HeaderStrip(props: {
  band: Band;
  kiosk: boolean;
  frameActions: FrameActions;
  part: HeaderPart;
}): JSX.Element | null {
  const { band, kiosk, frameActions, part } = props;
  const widgets = React.useMemo(() => headerWidgets(band, part), [band, part]);
  if (!bandVisible(band, kiosk) || widgets.length === 0) return null;
  return (
    <Box
      data-band="header"
      data-band-part={part}
      data-band-inline=""
      data-band-sticky={band.sticky ? '' : undefined}
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 2.5,
        flex: 'none',
        minHeight: HEADER_ROW_HEIGHT,
        minWidth: 0,
      }}
    >
      {widgets.map(w => (
        <Box
          key={w.id}
          data-header-item={w.type}
          sx={{ height: HEADER_ROW_HEIGHT, minWidth: 0, display: 'flex', alignItems: 'center' }}
        >
          <WidgetFrame
            sectionId={band.section.id}
            id={w.id}
            type={w.type}
            title={w.title}
            config={w.config}
            selfScroll={w.selfScroll}
            actions={frameActions}
            inline
          />
        </Box>
      ))}
    </Box>
  );
}
