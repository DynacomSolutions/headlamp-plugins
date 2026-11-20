/*
 * The icon before a row label. It fetches the icon through the source (see `rowIcons.ts`) and draws
 * an `<img>` of `ROW_ICON_SIZE` pixels from an object URL. While the icon loads, and when it fails,
 * the slot stays empty at the same size, so the labels of a widget stay aligned. Without a source
 * or an icon path the slot is empty too. The icon is never inline markup.
 */
import Box from '@mui/material/Box';
import React from 'react';
import type { PanelRowIcon } from './model';
import { acquireIcon, releaseIcon } from './rowIcons';
import type { PanelSource } from './sources';
import { sourceKey } from './sources';

export const ROW_ICON_SIZE = 20;

/** The object URL of an icon, or null while it loads or when it cannot be shown. */
export function useRowIconUrl(
  source: PanelSource | undefined,
  icon: PanelRowIcon | undefined
): string | null {
  const key = source && icon ? `${sourceKey(source)} ${icon.src}` : '';
  const [state, setState] = React.useState<{ key: string; url: string | null } | null>(null);
  React.useEffect(() => {
    if (!source || !icon) return undefined;
    let live = true;
    let held = false;
    acquireIcon(source, icon.src).then(url => {
      if (url === null) return;
      if (!live) {
        releaseIcon(source, icon.src);
        return;
      }
      held = true;
      setState({ key, url });
    });
    return () => {
      live = false;
      if (held) releaseIcon(source, icon.src);
    };
    // `key` covers the source location and the icon path.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return state?.key === key ? state.url : null;
}

export function RowIcon(props: {
  source: PanelSource | undefined;
  icon: PanelRowIcon | undefined;
}): JSX.Element {
  const url = useRowIconUrl(props.source, props.icon);
  return (
    <Box
      data-row-icon-slot
      sx={{
        width: ROW_ICON_SIZE,
        height: ROW_ICON_SIZE,
        flex: 'none',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        verticalAlign: 'middle',
      }}
    >
      {url !== null && props.icon && (
        <Box
          component="img"
          data-row-icon
          src={url}
          alt={props.icon.alt}
          title={props.icon.alt}
          sx={{
            width: ROW_ICON_SIZE,
            height: ROW_ICON_SIZE,
            objectFit: 'contain',
            display: 'block',
          }}
        />
      )}
    </Box>
  );
}
