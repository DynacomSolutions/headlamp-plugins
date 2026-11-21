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
import { useTokens } from './tokens';

/** The tile around the icon, and the icon inside it, in px. */
export const ROW_ICON_TILE = 24;
export const ROW_ICON_SIZE = 18;

/**
 * Some source icons draw in a fixed dark grey or navy that nearly vanishes on the black kiosk.
 * A brightness filter lifts them in the dark view only. The tile keeps every engine the same shape.
 */
export function darkIconFilter(src: string): string | undefined {
  if (/sqlite/i.test(src)) return 'brightness(2.8) saturate(0.8)';
  if (/(^|\/)(d1|kv|objectstore|queue)[.-]/i.test(src)) return 'brightness(2.2) saturate(0.5)';
  if (/postgres/i.test(src)) return 'brightness(1.7) saturate(0.9)';
  return undefined;
}

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
  const tk = useTokens();
  // An empty slot keeps its size but draws no tile, so the labels stay aligned.
  const tile = url !== null && props.icon;
  return (
    <Box
      data-row-icon-slot
      sx={{
        width: ROW_ICON_TILE,
        height: ROW_ICON_TILE,
        flex: 'none',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        verticalAlign: 'middle',
        borderRadius: '7px',
        bgcolor: tile ? tk.hover : undefined,
        boxShadow: tile ? `inset 0 0 0 1px ${tk.line}` : undefined,
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
            filter: tk.mode === 'dark' ? darkIconFilter(props.icon.src) : undefined,
          }}
        />
      )}
    </Box>
  );
}
