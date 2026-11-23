/*
 * The small icon tile in front of an org, a repo or a row that names them. Without an icon the slot
 * stays empty at the same size while another row has one, so the names stay aligned.
 */
import Box from '@mui/material/Box';
import React from 'react';
import { useTokens } from '../panels/tokens';

export const GROUP_ICON_TILE = 22;
export const GROUP_ICON_SIZE = 16;

export function GroupIcon(props: { src: string | undefined; name: string }): JSX.Element {
  const tk = useTokens();
  return (
    <Box
      data-group-icon-slot
      sx={{
        width: GROUP_ICON_TILE,
        height: GROUP_ICON_TILE,
        flex: 'none',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: '6px',
        bgcolor: props.src ? tk.hover : undefined,
        boxShadow: props.src ? `inset 0 0 0 1px ${tk.line}` : undefined,
      }}
    >
      {props.src && (
        <Box
          component="img"
          data-group-icon
          src={props.src}
          alt=""
          title={props.name}
          sx={{
            width: GROUP_ICON_SIZE,
            height: GROUP_ICON_SIZE,
            objectFit: 'contain',
            borderRadius: '3px',
            display: 'block',
          }}
        />
      )}
    </Box>
  );
}
