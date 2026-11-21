/*
 * The icon in front of a group name. It is the real icon of the app (see iconApi.ts), shown in a small
 * tile. A group with no icon, and an icon that fails to decode, show a neutral badge with the first letter
 * of the group name, so the names of all groups stay aligned.
 */
import Box from '@mui/material/Box';
import React from 'react';
import { mapIconFor } from './clusterApi';
import type { Placements, UptimeGroup } from './groups';
import { groupBackends } from './groups';
import { backendIconUrl } from './iconApi';

/** The tile around the icon, and the icon inside it, in px. */
export const ICON_TILE = 24;
export const ICON_SIZE = 18;

/** Where the icon of a group comes from: the icon map, the node glyph, or the app's own start page. */
export type IconSource = 'map' | 'node' | 'page';
export interface GroupIconInfo {
  url?: string;
  source: IconSource;
}

/**
 * The icon of every group that has one, by group key. A node group has the node glyph. A group in the icon map
 * (a ConfigMap, see clusterApi.ts) has that icon. Any other group asks its Service for the icon on its start
 * page (iconApi.ts), which works only where the Headlamp service account may use the Service proxy: when it may
 * not, the request fails quietly and the group keeps its initial badge. A group is added when its icon arrives.
 */
export function useGroupIcons(
  groups: UptimeGroup[],
  placements: Placements,
  iconMap: ReadonlyMap<string, string>
): ReadonlyMap<string, GroupIconInfo> {
  const [pages, setPages] = React.useState<ReadonlyMap<string, string>>(new Map());
  // One string that names every candidate, so the effect runs again only when the candidates change.
  const plan = React.useMemo(
    () =>
      groups
        .filter(g => !g.node && !mapIconFor(g.key, iconMap))
        .map(g => ({ key: g.key, backends: groupBackends(g, placements) })),
    [groups, placements, iconMap]
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
            setPages(prev => (prev.get(key) === url ? prev : new Map(prev).set(key, url)));
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
  return React.useMemo(() => {
    const out = new Map<string, GroupIconInfo>();
    for (const g of groups) {
      if (g.node) {
        out.set(g.key, { source: 'node' });
        continue;
      }
      const mapped = mapIconFor(g.key, iconMap);
      if (mapped) {
        out.set(g.key, { url: mapped, source: 'map' });
        continue;
      }
      const page = pages.get(g.key);
      if (page) out.set(g.key, { url: page, source: 'page' });
    }
    return out;
  }, [groups, iconMap, pages]);
}

/** The first letter of a group name, in capitals. */
export const initialOf = (name: string): string =>
  (name.match(/[\p{L}\p{N}]/u)?.[0] ?? '?').toUpperCase();

/** A plain server glyph for a node group. It uses the text colour, so it follows the theme. */
function NodeGlyph(): JSX.Element {
  return (
    <svg
      width={ICON_SIZE}
      height={ICON_SIZE}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      aria-hidden
    >
      <rect x="3" y="4" width="18" height="6.5" rx="1.6" />
      <rect x="3" y="13.5" width="18" height="6.5" rx="1.6" />
      <path d="M7 7.25h.01M7 16.75h.01" strokeWidth={2.4} />
    </svg>
  );
}

export function GroupIcon(props: {
  name: string;
  info?: GroupIconInfo;
  dark: boolean;
}): JSX.Element {
  const { name, info, dark } = props;
  const url = info?.url;
  const [failed, setFailed] = React.useState<string | null>(null);
  const shown = url && failed !== url ? url : undefined;
  const glyph = info?.source === 'node' && !url;
  const kind = shown ? 'image' : glyph ? 'node' : 'initial';
  return (
    <Box
      data-uptime-icon={kind}
      data-uptime-icon-source={shown || glyph ? info?.source : undefined}
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
      ) : glyph ? (
        <NodeGlyph />
      ) : (
        initialOf(name)
      )}
    </Box>
  );
}
