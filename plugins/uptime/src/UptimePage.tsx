/* The Uptime page: one row per check, a cell per site, TLS days, uptime and a 24h history strip. */
import { SectionBox } from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import IconButton from '@mui/material/IconButton';
import { useTheme } from '@mui/material/styles';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import React from 'react';
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip as ChartTooltip, XAxis, YAxis } from 'recharts';
import { HistoryStrip } from './HistoryStrip';
import { PROBE_JOB, queryMetrics, queryRange, RangeSeries } from './metrics';
import {
  buildChecks,
  Check,
  formatDays,
  formatLatency,
  formatPercent,
  HISTORY_HOURS,
  HISTORY_STEP_SEC,
  historyEnd,
  historyStart,
  latencyRows,
  queries,
  Raw,
  Severity,
  SiteResult,
  Status,
  summarise,
  tlsSeverity,
} from './model';

const REFRESH_MS = 30_000;
const LATENCY_STEP_SEC = 300;

const STATUS_LABEL: Record<Status, string> = { up: 'Up', down: 'Down', degraded: 'Degraded', unknown: 'No data' };
const STATUS_COLOUR: Record<Status, 'success' | 'error' | 'warning' | 'default'> = {
  up: 'success',
  down: 'error',
  degraded: 'warning',
  unknown: 'default',
};
const SEVERITY_COLOUR: Record<Severity, string | undefined> = { ok: undefined, warn: 'warning.main', crit: 'error.main' };
const POLICY_HELP = {
  all: 'Alerts when every site fails',
  any: 'Alerts when any site fails',
};

async function load(): Promise<Raw> {
  const q = queries(PROBE_JOB);
  const now = Math.floor(Date.now() / 1000);
  const [success, duration, httpStatus, tlsExpiry, siteUptime24h, uptime24h, uptime7d, history] = await Promise.all([
    queryMetrics(q.success),
    queryMetrics(q.duration),
    queryMetrics(q.httpStatus),
    queryMetrics(q.tlsExpiry),
    queryMetrics(q.siteUptime24h),
    queryMetrics(q.uptime24h),
    queryMetrics(q.uptime7d),
    queryRange(q.history, historyStart(now), historyEnd(now), HISTORY_STEP_SEC),
  ]);
  return { success, duration, httpStatus, tlsExpiry, siteUptime24h, uptime24h, uptime7d, history };
}

function useUptime() {
  const [state, setState] = React.useState<{ raw?: Raw; error?: string; loading: boolean; at?: number }>({ loading: true });
  React.useEffect(() => {
    let alive = true;
    const tick = () =>
      load()
        .then(raw => alive && setState({ raw, loading: false, at: Date.now() }))
        .catch(e => alive && setState(s => ({ ...s, error: String(e?.message || e), loading: false })));
    tick();
    const id = window.setInterval(tick, REFRESH_MS);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);
  return state;
}

function SiteCell({ site, type }: { site?: SiteResult; type: string }): JSX.Element {
  if (!site || site.up === undefined) {
    return <Typography variant="body2" color="text.secondary">-</Typography>;
  }
  const detail = [
    site.up ? 'Up' : 'Failing',
    site.httpStatus ? `HTTP ${site.httpStatus}` : undefined,
    site.latencySec !== undefined ? `took ${formatLatency(site.latencySec)}` : undefined,
    site.uptime24h !== undefined ? `${formatPercent(site.uptime24h)} over 24h` : undefined,
  ]
    .filter(Boolean)
    .join(', ');
  return (
    <Tooltip title={detail}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, whiteSpace: 'nowrap' }}>
        <Box
          component="span"
          aria-label={site.up ? 'up' : 'down'}
          sx={{ width: 10, height: 10, borderRadius: '50%', bgcolor: site.up ? 'success.main' : 'error.main', flex: 'none' }}
        />
        <Typography variant="body2" component="span" sx={{ color: site.up ? undefined : 'error.main' }}>
          {site.up ? formatLatency(site.latencySec) : type === 'http' && site.httpStatus ? `HTTP ${site.httpStatus}` : 'failing'}
        </Typography>
      </Box>
    </Tooltip>
  );
}

function CheckHistory({ check }: { check: Check }): JSX.Element {
  const failing = check.history.filter(v => v !== undefined && v < 0.999).length;
  const minutes = HISTORY_STEP_SEC / 60;
  return (
    <HistoryStrip
      history={check.history}
      startSec={historyStart(Date.now() / 1000)}
      stepSec={HISTORY_STEP_SEC}
      label={`${check.name}: ${failing} of ${check.history.length} ${minutes}-minute periods with failures in the last ${HISTORY_HOURS} hours`}
    />
  );
}

function LatencyChart({ check }: { check: Check }): JSX.Element {
  const theme = useTheme();
  const [series, setSeries] = React.useState<RangeSeries[] | undefined>();
  const [error, setError] = React.useState<string | undefined>();
  React.useEffect(() => {
    const end = Math.floor(Date.now() / 1000);
    queryRange(
      `avg_over_time(probe_duration_seconds{job="${PROBE_JOB}",target="${check.name}"}[${LATENCY_STEP_SEC}s])`,
      end - HISTORY_HOURS * 3600,
      end,
      LATENCY_STEP_SEC
    )
      .then(setSeries)
      .catch(e => setError(String(e?.message || e)));
  }, [check.name]);
  if (error) return <Alert severity="error">{error}</Alert>;
  if (!series) return <CircularProgress size={20} />;
  const { rows, sites } = latencyRows(series, check.name);
  if (rows.length === 0) return <Typography color="text.secondary">No latency data.</Typography>;
  const colours = [theme.palette.primary.main, theme.palette.secondary.main, theme.palette.info.main, theme.palette.warning.main];
  return (
    <Box sx={{ height: 220, width: '100%' }}>
      <Typography variant="subtitle2" component="h4">
        Probe duration per site, last {HISTORY_HOURS} hours ({LATENCY_STEP_SEC / 60}-minute average)
      </Typography>
      <ResponsiveContainer width="100%" height="90%">
        <LineChart data={rows} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={theme.palette.divider} />
          <XAxis
            dataKey="t"
            type="number"
            domain={['dataMin', 'dataMax']}
            tickFormatter={t => new Date(t * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            stroke={theme.palette.text.secondary}
          />
          <YAxis unit=" ms" width={70} stroke={theme.palette.text.secondary} />
          <ChartTooltip
            labelFormatter={t => new Date(Number(t) * 1000).toLocaleString()}
            formatter={(v: number) => `${v} ms`}
            contentStyle={{ background: theme.palette.background.paper, borderColor: theme.palette.divider }}
          />
          <Legend />
          {sites.map((site, i) => (
            <Line key={site} type="monotone" dataKey={site} dot={false} strokeWidth={1.5} stroke={colours[i % colours.length]} isAnimationActive={false} />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </Box>
  );
}

function CheckRow({ check, locations }: { check: Check; locations: string[] }): JSX.Element {
  const [open, setOpen] = React.useState(false);
  const cols = 8 + locations.length;
  return (
    <>
      <TableRow hover sx={{ '& > td': { borderBottom: open ? 'none' : undefined } }}>
        <TableCell padding="checkbox">
          <IconButton size="small" aria-label={open ? `Hide ${check.name} latency` : `Show ${check.name} latency`} onClick={() => setOpen(!open)}>
            <Box component="span" sx={{ display: 'inline-block', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 120ms' }}>
              ›
            </Box>
          </IconButton>
        </TableCell>
        <TableCell>
          <Chip size="small" label={STATUS_LABEL[check.status]} color={STATUS_COLOUR[check.status]} />
        </TableCell>
        <TableCell>
          <Typography variant="body2" sx={{ fontWeight: 500 }}>
            {check.name}
          </Typography>
          <Typography variant="caption" color="text.secondary" sx={{ wordBreak: 'break-all' }}>
            {check.instance}
          </Typography>
        </TableCell>
        <TableCell>
          <Tooltip title={POLICY_HELP[check.policy]}>
            <Typography variant="body2" component="span">
              {check.type.toUpperCase()} · {check.policy}
            </Typography>
          </Tooltip>
        </TableCell>
        {locations.map(l => (
          <TableCell key={l}>
            <SiteCell site={check.sites.get(l)} type={check.type} />
          </TableCell>
        ))}
        <TableCell sx={{ color: SEVERITY_COLOUR[tlsSeverity(check.tlsDaysLeft)], whiteSpace: 'nowrap' }}>{formatDays(check.tlsDaysLeft)}</TableCell>
        <TableCell align="right">{formatPercent(check.uptime24h)}</TableCell>
        <TableCell align="right">{formatPercent(check.uptime7d)}</TableCell>
        <TableCell sx={{ width: 260 }}>
          <CheckHistory check={check} />
        </TableCell>
      </TableRow>
      {open && (
        <TableRow>
          <TableCell colSpan={cols} sx={{ pt: 0 }}>
            <LatencyChart check={check} />
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

export function UptimePage(): JSX.Element {
  const { raw, error, loading, at } = useUptime();
  const built = React.useMemo(() => (raw ? buildChecks(raw, Math.floor((at ?? Date.now()) / 1000)) : undefined), [raw, at]);
  const counts = built ? summarise(built.checks) : undefined;
  return (
    <SectionBox title="Uptime">
      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          Could not read probe results: {error}
        </Alert>
      )}
      {loading && !built && <CircularProgress />}
      {built && built.checks.length === 0 && (
        <Alert severity="info">No probe results. The scrape job "{PROBE_JOB}" has no probe_success series yet.</Alert>
      )}
      {built && counts && built.checks.length > 0 && (
        <>
          <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'center', mb: 2 }}>
            <Chip label={`${counts.up} up`} color="success" variant="outlined" />
            {counts.degraded > 0 && <Chip label={`${counts.degraded} degraded`} color="warning" />}
            {counts.down > 0 && <Chip label={`${counts.down} down`} color="error" />}
            {counts.unknown > 0 && <Chip label={`${counts.unknown} no data`} variant="outlined" />}
            <Typography variant="caption" color="text.secondary" sx={{ ml: 'auto' }}>
              {built.locations.length} sites · refreshed {at ? new Date(at).toLocaleTimeString() : '-'} · every {REFRESH_MS / 1000} s
            </Typography>
          </Box>
          <Box sx={{ overflowX: 'auto' }}>
            <Table size="small" aria-label="Uptime checks">
              <TableHead>
                <TableRow>
                  <TableCell padding="checkbox" />
                  <TableCell>Status</TableCell>
                  <TableCell>Check</TableCell>
                  <TableCell>Type · policy</TableCell>
                  {built.locations.map(l => (
                    <TableCell key={l}>{l}</TableCell>
                  ))}
                  <TableCell>TLS</TableCell>
                  <TableCell align="right">24h</TableCell>
                  <TableCell align="right">7d</TableCell>
                  <TableCell>Last {HISTORY_HOURS} hours</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {built.checks.map(c => (
                  <CheckRow key={c.name} check={c} locations={built.locations} />
                ))}
              </TableBody>
            </Table>
          </Box>
        </>
      )}
    </SectionBox>
  );
}
