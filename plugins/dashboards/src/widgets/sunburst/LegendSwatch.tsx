import Box from '@mui/material/Box';
import { alpha, useTheme } from '@mui/material/styles';
import React from 'react';

/**
 * The small mark of a legend row: a solid colour, the faint tone of a node arc, or the crosshatch of
 * free capacity. The mark matches the arc it names.
 */
export function LegendSwatch({
  colour,
  tone,
  hatched = false,
}: {
  colour?: string;
  /** A node arc: the text colour at this opacity, with a thin edge so a faint tone stays visible. */
  tone?: number;
  hatched?: boolean;
}): JSX.Element {
  const theme = useTheme();
  const hatch = theme.palette.text.secondary;
  return (
    <Box
      component="span"
      aria-hidden
      sx={{
        width: 8,
        height: 8,
        borderRadius: '1px',
        flex: 'none',
        ...(hatched
          ? {
              border: 1,
              borderColor: 'text.disabled',
              backgroundImage: `repeating-linear-gradient(45deg, transparent 0 1.5px, ${hatch} 1.5px 2.2px)`,
            }
          : tone !== undefined
          ? {
              bgcolor: alpha(theme.palette.text.primary, tone),
              border: 1,
              borderColor: 'text.disabled',
            }
          : { bgcolor: colour }),
      }}
    />
  );
}
