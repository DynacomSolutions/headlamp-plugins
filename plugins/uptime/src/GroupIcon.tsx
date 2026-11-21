/*
 * The icon in front of a group name. It is the real icon of the app (see iconApi.ts), shown in a small
 * tile. A group with no icon, and an icon that fails to decode, show a neutral badge with the first letter
 * of the group name, so the names of all groups stay aligned.
 */
import Box from '@mui/material/Box';
import React from 'react';
import type { Placements, UptimeGroup } from './groups';
import { groupBackends } from './groups';
import { backendIconUrl } from './iconApi';

/** The tile around the icon, and the icon inside it, in px. */
export const ICON_TILE = 24;
export const ICON_SIZE = 18;

/** The icon URL of every group that has one, by group key. A group is added when its icon arrives. */
export function useGroupIcons(
  groups: UptimeGroup[],
  placements: Placements
): ReadonlyMap<string, string> {
  const [icons, setIcons] = React.useState<ReadonlyMap<string, string>>(new Map());
  // One string that names every candidate, so the effect runs again only when the candidates change.
  const plan = React.useMemo(
    () => groups.map(g => ({ key: g.key, backends: groupBackends(g, placements) })),
    [groups, placements]
  );
  const signature = plan
    .map(
      p =>
        `${p.key}=${p.backends
          .map(b => `${b.namespace}/${b.scheme ?? ''}${b.name}:${b.port ?? ''}`)
          .join(',')}`
    )
    .join('|');
  React.useEffect(() => {
    let live = true;
    for (const { key, backends } of plan) {
      if (backends.length === 0) continue;
      (async () => {
        for (const b of backends) {
          const url = await backendIconUrl(b);
          if (!live) return;
          if (url) {
            setIcons(prev => (prev.get(key) === url ? prev : new Map(prev).set(key, url)));
            return;
          }
        }
      })();
    }
    return () => {
      live = false;
    };
    // `signature` covers `plan`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);
  return icons;
}

/** The first letter of a group name, in capitals. */
export const initialOf = (name: string): string =>
  (name.match(/[\p{L}\p{N}]/u)?.[0] ?? '?').toUpperCase();

export function GroupIcon(props: { name: string; url?: string; dark: boolean }): JSX.Element {
  const { name, url, dark } = props;
  const [failed, setFailed] = React.useState<string | null>(null);
  const shown = url && failed !== url ? url : undefined;
  return (
    <Box
      data-uptime-icon={shown ? 'image' : 'initial'}
      aria-hidden
      sx={{
        width: ICON_TILE,
        height: ICON_TILE,
        flex: 'none',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: '7px',
        fontSize: 12.5,
        fontWeight: 600,
        lineHeight: 1,
        color: dark ? 'rgba(255,255,255,0.7)' : 'rgba(0,0,0,0.6)',
        bgcolor: dark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.05)',
        boxShadow: `inset 0 0 0 1px ${dark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.12)'}`,
        overflow: 'hidden',
      }}
    >
      {shown ? (
        <Box
          component="img"
          src={shown}
          alt=""
          onError={() => setFailed(shown)}
          sx={{ width: ICON_SIZE, height: ICON_SIZE, objectFit: 'contain', display: 'block' }}
        />
      ) : (
        initialOf(name)
      )}
    </Box>
  );
}
