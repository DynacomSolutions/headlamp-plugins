/*
 * A header control that is only an icon: the refresh and the full screen buttons. It has no plate,
 * no edge and no text. The icon has the colour of the icons in the tab rail (the quiet text
 * colour, the full text colour on hover). The tooltip and the aria-label keep the words.
 */
import { Icon } from '@iconify/react';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import React from 'react';

/** Size of the hit area, in px. */
export const HEADER_ICON_BUTTON_SIZE = 44;
/** The hit area in the kiosk, a touch size. */
export const HEADER_ICON_BUTTON_TOUCH_SIZE = 48;

export function HeaderIconButton(props: {
  label: string;
  icon: string;
  onClick: () => void;
  /** Size of the icon, in px. */
  iconSize?: number;
  /** The wall screen is a touch screen: a larger hit area. */
  touch?: boolean;
}): JSX.Element {
  const { label, icon, onClick, iconSize = 24, touch } = props;
  const size = touch ? HEADER_ICON_BUTTON_TOUCH_SIZE : HEADER_ICON_BUTTON_SIZE;
  return (
    <Tooltip title={label}>
      <IconButton
        aria-label={label}
        onClick={onClick}
        data-header-icon-button=""
        sx={{
          width: size,
          height: size,
          minWidth: size,
          minHeight: size,
          flex: 'none',
          p: 0,
          // The colour of the tab rail icons.
          color: 'text.secondary',
          bgcolor: 'transparent',
          border: 0,
          '&:hover, &:active': { bgcolor: 'transparent', color: 'text.primary' },
        }}
      >
        <Icon icon={icon} width={iconSize} height={iconSize} />
      </IconButton>
    </Tooltip>
  );
}
