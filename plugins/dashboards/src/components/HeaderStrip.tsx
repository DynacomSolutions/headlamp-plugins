/*
 * The widgets of the dashboard header, drawn inline in the title bar: one compact row between the
 * title, filters and views group and the full screen button. Each widget draws without a card and
 * gets `compact`, so a clock shows the time and the date stacked, at the height of the row. Edit
 * mode keeps the header band with its grid, so widgets can still be added, moved, configured and
 * removed there.
 */
import Box from '@mui/material/Box';
import React from 'react';
import type { Band } from '../spec/model';
import { bandVisible } from './BandView';
import { FrameActions, WidgetFrame } from './WidgetFrame';

/** The height of the header row, in pixels. The clock and the buttons fit it. */
export const HEADER_ROW_HEIGHT = 48;

export function HeaderStrip(props: {
  band: Band;
  kiosk: boolean;
  frameActions: FrameActions;
}): JSX.Element | null {
  const { band, kiosk, frameActions } = props;
  const widgets = React.useMemo(
    () => [...band.section.widgets].sort((a, b) => a.y - b.y || a.x - b.x),
    [band.section.widgets]
  );
  if (!bandVisible(band, kiosk)) return null;
  return (
    <Box
      data-band="header"
      data-band-inline=""
      data-band-sticky={band.sticky ? '' : undefined}
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 2,
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
