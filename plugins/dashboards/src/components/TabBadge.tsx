/*
 * The count on a tab in the rail, for example the open incidents. It reads one panel of a panel
 * source and fetches when the dashboard refresh signal changes. A count of 0, a failed fetch and a
 * missing source show nothing. The count has a filled shape and a number, never colour alone.
 */
import Box from '@mui/material/Box';
import React from 'react';
import type { TabBadge as TabBadgeSpec } from '../spec/model';
import { usePanel } from '../widgets/panels/data';
import type { PanelModel } from '../widgets/panels/model';
import { useSourceLookup } from '../widgets/panels/sourcesConfig';
import { STATUS_HUES } from '../widgets/panels/tokens';

/** The count of a panel for a badge: the stat with that label, else the leading number of the summary. */
export function badgeCount(panel: PanelModel | null, stat?: string): number {
  if (!panel) return 0;
  const text = stat
    ? panel.stats.find(s => s.label.toLowerCase() === stat.toLowerCase())?.value ?? ''
    : panel.summary;
  const n = parseInt(text.replace(/[^\d].*$/, ''), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

const noop = (): void => undefined;

export function TabBadge(props: {
  badge: TabBadgeSpec;
  refreshSignal: number;
  /** Draw in a row (the wide tab) instead of over the icon. */
  inline?: boolean;
}): JSX.Element | null {
  const { badge, refreshSignal, inline } = props;
  const { source } = useSourceLookup(badge.source);
  const state = usePanel(source, badge.panel, refreshSignal, 0, noop, badge.source);
  const n = badgeCount(state.panel, badge.stat);
  if (n <= 0) return null;
  return (
    <Box
      component="span"
      data-tab-badge={n}
      title={`${n} ${badge.panel}`}
      sx={theme => ({
        position: inline ? 'static' : 'absolute',
        top: -6,
        left: 'calc(100% - 6px)',
        ml: inline ? 'auto' : 0,
        minWidth: 20,
        height: 18,
        px: '5px',
        borderRadius: '9px',
        fontSize: 11,
        lineHeight: '18px',
        textAlign: 'center',
        fontWeight: 600,
        fontVariantNumeric: 'tabular-nums',
        bgcolor: STATUS_HUES[theme.palette.mode === 'dark' ? 'dark' : 'light'].crit,
        color: theme.palette.mode === 'dark' ? '#000' : '#fff',
      })}
    >
      {n > 99 ? '99+' : n}
    </Box>
  );
}
