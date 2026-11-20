/*
 * Draws a PanelModel: the status and summary, stats as tiles, rows as a table with fraction bars
 * and links, series as sparklines and rings as sunbursts. Pure rendering, so it is easy to test.
 * Status is never colour alone: each status has its own shape and its own word.
 */
import Box from '@mui/material/Box';
import { useTheme } from '@mui/material/styles';
import Typography from '@mui/material/Typography';
import React from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { SunburstChart } from '../sunburst/SunburstChart';
import { isEmptyPanel, PanelModel, PanelRing, PanelRow, PanelStatus, ringToSunburst } from './model';
import { Sparkline } from './Sparkline';

export const STATUS_WORD: Record<PanelStatus, string> = { ok: 'OK', warn: 'Warning', crit: 'Critical', unknown: 'Unknown' };

/** Status colours from the theme. They are reserved for status, never used for a series. */
export function useStatusColours(): Record<PanelStatus, string> {
  const t = useTheme();
  return { ok: t.palette.success.main, warn: t.palette.warning.main, crit: t.palette.error.main, unknown: t.palette.text.secondary };
}

/** A status mark with its own shape: circle (ok), triangle (warning), square (critical), ring (unknown). */
export function StatusMark(props: { status: PanelStatus; size?: number }): JSX.Element {
  const colours = useStatusColours();
  const { status, size = 12 } = props;
  const c = colours[status];
  return (
    <svg role="img" aria-label={STATUS_WORD[status]} width={size} height={size} viewBox="0 0 12 12" data-status={status} style={{ flex: 'none' }}>
      {status === 'ok' && <circle cx="6" cy="6" r="5" fill={c} />}
      {status === 'warn' && <path d="M6 1 L11 11 L1 11 Z" fill={c} />}
      {status === 'crit' && <rect x="1.5" y="1.5" width="9" height="9" rx="1" fill={c} />}
      {status === 'unknown' && <circle cx="6" cy="6" r="4" fill="none" stroke={c} strokeWidth="2" />}
    </svg>
  );
}

function Label(props: { row: PanelRow; editing: boolean }): JSX.Element {
  const { row, editing } = props;
  const link = row.link;
  if (!link || editing) return <>{row.label}</>;
  return link.startsWith('/') ? (
    <RouterLink to={link} style={{ color: 'inherit' }}>
      {row.label}
    </RouterLink>
  ) : (
    <a href={link} target="_blank" rel="noopener noreferrer" style={{ color: 'inherit' }}>
      {row.label}
    </a>
  );
}

function FractionBar(props: { fraction: number; status: PanelStatus }): JSX.Element {
  const colours = useStatusColours();
  const theme = useTheme();
  const track = theme.palette.mode === 'dark' ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.10)';
  return (
    <Box
      role="img"
      aria-label={`${Math.round(props.fraction * 100)} percent`}
      sx={{ height: 6, borderRadius: '3px', bgcolor: track, overflow: 'hidden', minWidth: 48 }}
    >
      <Box data-fraction={props.fraction} sx={{ height: '100%', width: `${props.fraction * 100}%`, bgcolor: colours[props.status === 'unknown' ? 'ok' : props.status] }} />
    </Box>
  );
}

export const ringFormat = (ring: PanelRing) => (v: number): string => {
  if (ring.unit === 'cores') return `${v >= 100 ? v.toFixed(0) : v.toFixed(2)} cores`;
  if (ring.unit === 'bytes') {
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
    let n = v;
    let i = 0;
    while (n >= 1024 && i < units.length - 1) {
      n /= 1024;
      i++;
    }
    return `${n.toFixed(i === 0 || n >= 100 ? 0 : n >= 10 ? 1 : 2)} ${units[i]}`;
  }
  return `${v}`;
};

export interface PanelViewProps {
  panel: PanelModel;
  kiosk: boolean;
  editing: boolean;
}

export function PanelView({ panel, kiosk, editing }: PanelViewProps): JSX.Element {
  const withBar = panel.rows.some(r => r.fraction !== undefined);
  if (isEmptyPanel(panel)) {
    return (
      <Box data-panel-empty sx={{ p: 1 }}>
        <Typography variant="body2" color="text.secondary">
          This panel has nothing to show right now.
        </Typography>
      </Box>
    );
  }
  return (
    <Box data-panel={panel.id} sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, minWidth: 0 }}>
      {(panel.summary || panel.status !== 'unknown') && (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <StatusMark status={panel.status} size={14} />
          <Typography variant="body2" data-panel-summary sx={{ fontWeight: 500 }}>
            {panel.summary || STATUS_WORD[panel.status]}
          </Typography>
        </Box>
      )}
      {panel.stats.length > 0 && (
        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(84px, 1fr))', gap: 1 }}>
          {panel.stats.map((s, i) => (
            <Box
              key={`${s.label}-${i}`}
              data-stat
              sx={{ border: 1, borderColor: 'divider', borderRadius: 1, px: 1, py: 0.75, minWidth: 0, bgcolor: kiosk ? 'transparent' : undefined }}
            >
              <Typography variant="caption" color="text.secondary" noWrap component="div">
                {s.label}
              </Typography>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                <StatusMark status={s.status} size={10} />
                <Typography variant="h6" component="div" sx={{ lineHeight: 1.2, fontVariantNumeric: 'tabular-nums' }}>
                  {s.value}
                </Typography>
              </Box>
            </Box>
          ))}
        </Box>
      )}
      {panel.rings.length > 0 && (
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 2, justifyContent: 'center' }}>
          {panel.rings.map(ring => (
            <Box key={ring.id} data-ring={ring.id} sx={{ width: 'min(320px, 100%)', height: 300 }}>
              <SunburstChart data={ringToSunburst(ring)} title={ring.label} format={ringFormat(ring)} kiosk={kiosk} />
            </Box>
          ))}
        </Box>
      )}
      {panel.series.length > 0 && (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
          {panel.series.map((s, i) => (
            <Box key={`${s.label}-${i}`} data-series sx={{ display: 'grid', gridTemplateColumns: 'minmax(60px, 30%) 1fr', alignItems: 'center', gap: 1 }}>
              <Typography variant="caption" color="text.secondary" noWrap>
                {s.label}
              </Typography>
              <Sparkline label={s.label} points={s.points} />
            </Box>
          ))}
        </Box>
      )}
      {panel.rows.length > 0 && (
        <Box component="table" data-rows sx={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8125rem' }}>
          <tbody>
            {panel.rows.map((r, i) => (
              <Box component="tr" key={`${r.label}-${i}`} data-row sx={{ borderTop: i === 0 ? 0 : 1, borderColor: 'divider' }}>
                <Box component="td" sx={{ py: 0.5, pr: 1, width: 18 }}>
                  <StatusMark status={r.status} size={10} />
                </Box>
                <Box component="td" sx={{ py: 0.5, pr: 1, maxWidth: 220 }}>
                  <Typography variant="body2" noWrap title={r.label}>
                    <Label row={r} editing={editing} />
                  </Typography>
                  {r.detail && (
                    <Typography variant="caption" color="text.secondary" noWrap component="div" title={r.detail}>
                      {r.detail}
                    </Typography>
                  )}
                </Box>
                {withBar && (
                  <Box component="td" sx={{ py: 0.5, pr: 1, width: '28%' }}>
                    {r.fraction !== undefined && <FractionBar fraction={r.fraction} status={r.status} />}
                  </Box>
                )}
                <Box component="td" sx={{ py: 0.5, textAlign: 'right', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
                  {r.value}
                </Box>
              </Box>
            ))}
          </tbody>
        </Box>
      )}
    </Box>
  );
}
