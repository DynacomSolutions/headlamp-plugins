/*
 * The dashboard header and footer: one section of widgets that shows with every tab, above and
 * below the tab content. In edit mode it always shows, with its two options (sticky, and where it
 * shows). In view mode an empty band, or one that is set to show only in the other view, draws
 * nothing. A sticky band stays at the top (header) or the bottom (footer) of the scrolling view.
 */
import Box from '@mui/material/Box';
import FormControlLabel from '@mui/material/FormControlLabel';
import MenuItem from '@mui/material/MenuItem';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import React from 'react';
import type { Band, BandKey, BandShow } from '../spec/model';
import { SectionActions, SectionView } from './SectionView';
import { FrameActions } from './WidgetFrame';

export const BAND_SHOW_LABELS: Record<BandShow, string> = {
  both: 'Normal view and kiosk',
  normal: 'Normal view only',
  kiosk: 'Kiosk only',
};

const NAMES: Record<BandKey, string> = { header: 'Header', footer: 'Footer' };

/** Whether a band draws in view mode: it has widgets and its `show` option allows this view. */
export function bandVisible(band: Band, kiosk: boolean): boolean {
  if (band.section.widgets.length === 0) return false;
  return band.show === 'both' || band.show === (kiosk ? 'kiosk' : 'normal');
}

export interface BandActions {
  setSticky(key: BandKey, sticky: boolean): void;
  setShow(key: BandKey, show: BandShow): void;
}

export function BandView(props: {
  bandKey: BandKey;
  band: Band;
  editing: boolean;
  kiosk: boolean;
  frameActions: FrameActions;
  sectionActions: SectionActions;
  bandActions: BandActions;
}): JSX.Element | null {
  const { bandKey, band, editing, kiosk, frameActions, sectionActions, bandActions } = props;
  if (!editing && !bandVisible(band, kiosk)) return null;
  const sticky = !editing && band.sticky;
  const name = NAMES[bandKey];
  return (
    <Box
      data-band={bandKey}
      data-band-sticky={band.sticky ? '' : undefined}
      sx={{
        position: sticky ? 'sticky' : 'relative',
        top: sticky && bandKey === 'header' ? 0 : undefined,
        bottom: sticky && bandKey === 'footer' ? 0 : undefined,
        zIndex: sticky ? 4 : undefined,
        bgcolor: sticky ? 'background.default' : undefined,
        flex: 'none',
      }}
    >
      {editing && (
        <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 1.5, mb: 0.5 }}>
          <Typography variant="subtitle2" component="h2">
            {name}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            Shown with every tab, {bandKey === 'header' ? 'above' : 'below'} the tab content.
          </Typography>
          <Box sx={{ flex: 1 }} />
          <FormControlLabel
            control={
              <Switch
                size="small"
                checked={band.sticky}
                onChange={e => bandActions.setSticky(bandKey, e.target.checked)}
              />
            }
            label={`Sticky at the ${bandKey === 'header' ? 'top' : 'bottom'}`}
          />
          <TextField
            select
            size="small"
            label={`Show ${name.toLowerCase()} in`}
            value={band.show}
            onChange={e => bandActions.setShow(bandKey, e.target.value as BandShow)}
            sx={{ minWidth: 200 }}
          >
            {(Object.keys(BAND_SHOW_LABELS) as BandShow[]).map(v => (
              <MenuItem key={v} value={v}>
                {BAND_SHOW_LABELS[v]}
              </MenuItem>
            ))}
          </TextField>
        </Box>
      )}
      <SectionView
        section={band.section}
        index={0}
        count={1}
        editing={editing}
        kiosk={kiosk}
        frameActions={frameActions}
        actions={sectionActions}
        bare
      />
    </Box>
  );
}
