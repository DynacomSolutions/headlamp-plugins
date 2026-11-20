/* The status of a threshold: an icon and a word in the status colour. Colour is never the only cue. */
import { Icon } from '@iconify/react';
import Box from '@mui/material/Box';
import React from 'react';
import { Level, LEVEL_COLOUR, LEVEL_ICON, LEVEL_LABEL } from './thresholds';

export function LevelBadge(props: { level: Level; color: string }): JSX.Element {
  const { level } = props;
  return (
    <Box data-level={level} sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, color: props.color, fontSize: 'clamp(0.7rem, 5cqmin, 1rem)' }}>
      <Icon icon={LEVEL_ICON[level]} width="1.2em" height="1.2em" style={{ color: LEVEL_COLOUR[level] }} />
      <span>{LEVEL_LABEL[level]}</span>
    </Box>
  );
}
