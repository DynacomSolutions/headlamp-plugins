import { SectionBox } from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControlLabel from '@mui/material/FormControlLabel';
import Link from '@mui/material/Link';
import { Theme } from '@mui/material/styles';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import React from 'react';
import { useHistory, useLocation } from 'react-router-dom';
import {
  applyDefaults,
  applyLimits,
  describeError,
  useAgentResource,
  useChanges,
  useSettings,
} from './data';
import {
  AgentDefault,
  agentLabel,
  agentLabelParts,
  AgentResourceState,
  agentSlices,
  AgentTreeRow,
  alertsByUnit,
  barGeometry,
  buildTree,
  canEdit,
  changeLabel,
  ChangeRecord,
  checkDefaults,
  checkEdit,
  CPU_QUOTA_LABEL,
  cpuInput,
  cpuLimitText,
  cpuPressureLevel,
  cpuShare,
  cpuShareLevel,
  currentValue,
  defaultFieldLabel,
  DefaultForm,
  describeChange,
  driftValue,
  editableFields,
  EditField,
  EditForm,
  EVENT_LABELS,
  FIELD_LABELS,
  formatCores,
  formatCpuUse,
  formatRatio,
  formatSize,
  formatSpan,
  formatStall,
  GuideCell,
  guideCells,
  hasCpu,
  isAgent,
  LayerLimits,
  Limit,
  MemAlert,
  MemUnit,
  Orchestrator,
  orchestratorAgents,
  orchestratorUnits,
  parseCpuQuota,
  parseSize,
  processTotal,
  ProjectGroup,
  quotaText,
  raisedTitle,
  shortName,
  sizeInput,
  stallLevel,
  swapText,
  threadName,
  throttleLevel,
  TREE_COLUMN_WIDTHS,
  unitDetail,
  unitLabel,
  visibleAlerts,
  windowedEvent,
  worstSeverity,
} from './model';
import { Chevron, processSummary, ProcessTree } from './processes';
import { parseView, toggled, viewSearch,ViewState } from './urlState';

const LEVEL_PALETTE = { ok: 'success', warning: 'warning', critical: 'error' } as const;

/** The dark theme's .main shades are pale; its .dark shades keep the fill visibly coloured. */
function levelColour(theme: Theme, level: keyof typeof LEVEL_PALETTE): string {
  const c = theme.palette[LEVEL_PALETTE[level]];
  return theme.palette.mode === 'dark' ? c.dark : c.main;
}

/** Usage bar with the soft (amber) and hard (red) limits drawn as lines. */
function UsageBar({ unit, hostTotal }: { unit: MemUnit; hostTotal: number }) {
  const g = barGeometry(unit, hostTotal);
  const label = `${formatSize(unit.current)} used; soft limit ${formatSize(
    unit.high
  )}; hard limit ${formatSize(unit.max)}`;
  return (
    <Tooltip title={label}>
      <Box
        role="img"
        aria-label={label}
        sx={{
          position: 'relative',
          height: 14,
          width: '100%',
          minWidth: 0,
          boxSizing: 'border-box',
          borderRadius: 0.5,
          bgcolor: 'action.selected',
          border: 1,
          borderColor: 'divider',
          overflow: 'hidden',
        }}
      >
        <Box
          sx={{
            position: 'absolute',
            inset: 0,
            width: `${g.fill}%`,
            bgcolor: (theme: Theme) => levelColour(theme, g.level),
          }}
        />
        {g.highAt !== null && g.highAt < 100 && (
          <Box
            sx={{
              position: 'absolute',
              top: 0,
              bottom: 0,
              left: `${g.highAt}%`,
              width: 2,
              bgcolor: 'warning.dark',
            }}
          />
        )}
        {g.maxAt !== null && (
          <Box
            sx={{
              position: 'absolute',
              top: 0,
              bottom: 0,
              left: `calc(${g.maxAt}% - 2px)`,
              width: 2,
              bgcolor: 'error.dark',
            }}
          />
        )}
      </Box>
    </Tooltip>
  );
}

/** Chips stay on one line, slightly smaller, so rows stay short. */
const CHIP_ROW_SX = {
  '& .MuiChip-root': { height: 20, flexShrink: 0 },
  '& .MuiChip-label': { px: 0.75, fontSize: 11 },
} as const;

const EVENT_ITEMS: [string, boolean][] = [
  ['high', false],
  ['max', true],
  ['oom', true],
  ['oom_kill', true],
];

/**
 * Event counts over the recent window. Only the windowed count drives the
 * colour; the lifetime total is secondary text in the tooltip.
 */
function EventChips({ unit }: { unit: MemUnit }) {
  const w = unit.eventsWindow;
  const span = w ? formatSpan(w.windowSeconds) : '';
  return (
    <Box display="flex" gap={0.5} flexWrap="nowrap" sx={CHIP_ROW_SX}>
      {EVENT_ITEMS.map(([key, severe]) => {
        const { n, active: windowActive } = windowedEvent(unit, key);
        // Soft-limit (`high`) events are routine kernel reclaim: show, never colour.
        const active = windowActive && key !== 'high';
        const total = unit.eventsLocal[key] ?? 0;
        const title = w
          ? `${EVENT_LABELS[key]}: ${n.toLocaleString()} in the last ${span}${
              w.partial ? ' (this unit is newer than the window)' : ''
            }. Cumulative since the cgroup was created: ${total.toLocaleString()} events.`
          : `${
              EVENT_LABELS[key]
            }: ${total.toLocaleString()} cumulative events since the cgroup was created (the backend does not report a recent window).`;
        return (
          <Tooltip key={key} title={title}>
            <Chip
              size="small"
              variant={active ? 'filled' : 'outlined'}
              color={active ? (severe ? 'error' : 'warning') : 'default'}
              label={
                w
                  ? `${key.replace('_', ' ')} ${n.toLocaleString()}`
                  : `${key.replace('_', ' ')} ${total.toLocaleString()}`
              }
            />
          </Tooltip>
        );
      })}
    </Box>
  );
}

/** Stall time over the window, with the lifetime total and averages secondary. */
function Pressure({ unit }: { unit: MemUnit }) {
  const w = unit.pressureWindow;
  const span = w ? formatSpan(w.windowSeconds) : '';
  const level = stallLevel(unit);
  const title = `Time fully stalled on memory (PSI full): every task waiting for memory at once. ${
    w
      ? `${formatStall(w.fullUs)} in the last ${span}; time with some task stalled: ${formatStall(
          w.someUs
        )}. `
      : ''
  }Cumulative since the cgroup was created: ${formatStall(
    unit.pressureFull.totalUs
  )} full, ${formatStall(
    unit.pressureSome.totalUs
  )} some. Averages: full ${unit.pressureFull.avg10.toFixed(
    1
  )}% over 10 s, ${unit.pressureFull.avg60.toFixed(1)}% over 60 s.`;
  return (
    <Tooltip title={title}>
      <Box display="flex" gap={0.5} flexWrap="nowrap" sx={CHIP_ROW_SX}>
        <Chip
          size="small"
          variant={level === 'default' ? 'outlined' : 'filled'}
          color={level}
          label={`full ${
            w ? formatStall(w.fullUs) : formatStall(unit.pressureFull.totalUs) + ' total'
          }`}
        />
        <Chip
          size="small"
          variant="outlined"
          label={`some ${
            w ? formatStall(w.someUs) : formatStall(unit.pressureSome.totalUs) + ' total'
          }`}
        />
      </Box>
    </Tooltip>
  );
}

/** Throttling: the share of time spent throttled over the last sample, and the period count. */
function ThrottleChips({ unit }: { unit: MemUnit }) {
  const r = unit.cpuThrottledRatio;
  if (typeof r !== 'number') {
    return (
      <Typography variant="body2" color="text.secondary">
        -
      </Typography>
    );
  }
  const level = throttleLevel(unit);
  const n = unit.cpuNrThrottled ?? 0;
  const title = `Throttled for ${formatRatio(
    r
  )} of the last sample (100% is the time of one core). ${n.toLocaleString()} of ${(
    unit.cpuNrPeriods ?? 0
  ).toLocaleString()} scheduler periods were throttled since the cgroup was created, ${formatStall(
    unit.cpuThrottledUsec ?? 0
  )} in total.`;
  return (
    <Tooltip title={title}>
      <Box display="flex" gap={0.5} flexWrap="nowrap" sx={CHIP_ROW_SX}>
        <Chip
          size="small"
          variant={level === 'default' ? 'outlined' : 'filled'}
          color={level}
          label={formatRatio(r)}
        />
        <Chip size="small" variant="outlined" label={`${n.toLocaleString()} periods`} />
      </Box>
    </Tooltip>
  );
}

/** CPU pressure (PSI): the 10 second average of time some or all tasks waited for CPU. */
function CpuPressure({ unit }: { unit: MemUnit }) {
  const some = unit.cpuPressureSome;
  const full = unit.cpuPressureFull;
  if (!some) {
    return (
      <Typography variant="body2" color="text.secondary">
        -
      </Typography>
    );
  }
  const level = cpuPressureLevel(unit);
  const title = `Time with a task waiting for CPU (PSI some): ${some.avg10.toFixed(
    1
  )}% over 10 s, ${some.avg60.toFixed(1)}% over 60 s, ${some.avg300.toFixed(
    1
  )}% over 5 min. Cumulative since the cgroup was created: ${formatStall(some.totalUs)} some${
    full ? `, ${formatStall(full.totalUs)} full` : ''
  }.`;
  return (
    <Tooltip title={title}>
      <Box display="flex" gap={0.5} flexWrap="nowrap" sx={CHIP_ROW_SX}>
        <Chip
          size="small"
          variant={level === 'default' ? 'outlined' : 'filled'}
          color={level}
          label={`some ${some.avg10.toFixed(1)}%`}
        />
        {full && <Chip size="small" variant="outlined" label={`full ${full.avg10.toFixed(1)}%`} />}
      </Box>
    </Tooltip>
  );
}

/** The five CPU cells of a unit row: use, limit, share of the limit, throttling and pressure. */
function CpuCells({ unit }: { unit: MemUnit }) {
  if (!hasCpu(unit)) return <EmptyCells n={CPU_COLUMNS} />;
  const share = cpuShare(unit);
  const level = cpuShareLevel(unit);
  return (
    <>
      <TableCell align="right">
        {unit.cpuCores === undefined ? '-' : formatCpuUse(unit.cpuCores)}
      </TableCell>
      <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
        <Tooltip
          title={
            unit.cpuQuotaCores === null
              ? 'No CPU limit on this unit (cpu.max is max). A limit on a slice above it still applies.'
              : `CPU limit (CPUQuota): ${cpuLimitText(unit.cpuQuotaCores)}, weight ${
                  unit.cpuWeight ?? '-'
                }`
          }
        >
          <span>{cpuLimitText(unit.cpuQuotaCores)}</span>
        </Tooltip>
      </TableCell>
      <TableCell align="right">
        {share === null ? (
          '-'
        ) : (
          <Tooltip
            title={`${formatCpuUse(unit.cpuCores ?? 0)} of ${cpuLimitText(
              unit.cpuQuotaCores
            )} in use`}
          >
            <Box display="inline-flex" sx={CHIP_ROW_SX}>
              <Chip
                size="small"
                variant={level === 'default' ? 'outlined' : 'filled'}
                color={level}
                label={formatRatio(share)}
              />
            </Box>
          </Tooltip>
        )}
      </TableCell>
      <TableCell>
        <ThrottleChips unit={unit} />
      </TableCell>
      <TableCell>
        <CpuPressure unit={unit} />
      </TableCell>
    </>
  );
}

function AlertBadges({ alerts }: { alerts: MemAlert[] | undefined }) {
  if (!alerts || alerts.length === 0)
    return (
      <Typography variant="body2" color="text.secondary">
        -
      </Typography>
    );
  return (
    <Box display="flex" gap={0.5} flexWrap="wrap">
      {alerts.map(a => (
        <Tooltip key={a.reason} title={a.detail}>
          <Chip
            size="small"
            color={a.severity === 'critical' ? 'error' : 'warning'}
            label={a.reason}
          />
        </Tooltip>
      ))}
    </Box>
  );
}

function HostSummary({ state }: { state: AgentResourceState }) {
  const { total, available } = state.host;
  const free = total > 0 ? available / total : 1;
  const low = free < state.policy.keepFree;
  return (
    <Box display="flex" gap={1} flexWrap="wrap" alignItems="center" mb={2}>
      <Chip label={`Host ${state.node || 'unknown'}`} />
      <Chip label={`${state.t3.agents} T3 agent${state.t3.agents === 1 ? '' : 's'}`} />
      <Chip
        color={low ? 'warning' : 'default'}
        label={`${formatSize(available)} of ${formatSize(total)} available (${(free * 100).toFixed(
          0
        )}%, policy keeps ${(state.policy.keepFree * 100).toFixed(0)}% free)`}
      />
      <Chip
        variant="outlined"
        label={`Heavy job guidance: ${state.policy.heavyHigh} soft, ${state.policy.heavyMax} hard, ${state.policy.heavySwap} swap`}
      />
      {state.host.cpus ? (
        <Tooltip title="CPUs of the host. The agents slice may use all of them except the reserve, which stays free for the control units and the host.">
          <Chip
            variant="outlined"
            label={`${state.host.cpus} CPUs${
              state.host.cpuReserve ? `, ${formatCores(state.host.cpuReserve)} reserved` : ''
            }`}
          />
        </Tooltip>
      ) : null}
      {!state.writable && <Chip variant="outlined" color="warning" label="Read only" />}
    </Box>
  );
}

/** Warnings the backend sent to agents in the last 24 hours; older ones drop off. */
function WarningsPanel({ state }: { state: AgentResourceState }) {
  const { warnings, warningPolicy: p } = state;
  const interval = p.intervalSeconds ? formatSpan(p.intervalSeconds) : '30 min';
  const rule = `Agents are told only about a real memory problem in the window: hard-limit or soft-limit events, OOM kills, or full stall time of ${
    p.stallSeconds ?? 10
  } s near the limit. Swap use never warns. At most one per agent and type every ${interval}.`;
  if (!p.enabled) {
    return (
      <Alert severity="info" sx={{ mb: 2 }}>
        Agent warnings are switched off on the backend.
      </Alert>
    );
  }
  return (
    <Box mb={2}>
      <Typography variant="subtitle2">Warnings sent to agents (last 24 hours)</Typography>
      <Typography variant="caption" color="text.secondary" display="block">
        {rule}
      </Typography>
      {warnings.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          None.
        </Typography>
      ) : (
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Time</TableCell>
              <TableCell>Agent</TableCell>
              <TableCell>Reached</TableCell>
              <TableCell>Result</TableCell>
              <TableCell>Message</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {warnings.map(w => (
              <TableRow key={`${w.time}/${w.unit}/${w.types.join(',')}`}>
                <TableCell sx={{ whiteSpace: 'nowrap' }}>
                  {new Date(w.time).toLocaleString()}
                </TableCell>
                <TableCell>
                  <Tooltip title={w.unit}>
                    <span>{w.displayName}</span>
                  </Tooltip>
                  {w.agent && (
                    <Typography variant="caption" color="text.secondary" display="block">
                      {w.agent}
                    </Typography>
                  )}
                </TableCell>
                <TableCell>{w.types.join(', ')}</TableCell>
                <TableCell>
                  {w.sent ? (
                    <Chip size="small" color="success" label={w.test ? 'Test sent' : 'Sent'} />
                  ) : (
                    <Tooltip title={w.error}>
                      <Chip size="small" color="warning" label="Not delivered" />
                    </Tooltip>
                  )}
                </TableCell>
                <TableCell>{w.message}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Box>
  );
}

function AlertsPanel({
  alerts,
  labelFor,
}: {
  alerts: MemAlert[];
  labelFor: (unit: string) => string;
}) {
  if (alerts.length === 0) {
    return (
      <Alert severity="success" sx={{ mb: 2 }}>
        No unit is at its soft or hard limit and no limit event has fired in the recent window.
      </Alert>
    );
  }
  const critical = alerts.filter(a => a.severity === 'critical');
  const warnings = alerts.filter(a => a.severity === 'warning');
  const list = (items: MemAlert[]) =>
    items.map(a => (
      <li key={`${a.unit}/${a.reason}`}>
        <strong>{a.unit === 'host' ? 'Host' : labelFor(a.unit)}</strong>: {a.detail}
      </li>
    ));
  return (
    <Box mb={2} display="flex" flexDirection="column" gap={1}>
      {critical.length > 0 && (
        <Alert severity="error">
          <strong>{critical.length} critical</strong> (hard limit reached, or OOM activity)
          <ul style={{ margin: 0, paddingLeft: 20 }}>{list(critical)}</ul>
        </Alert>
      )}
      {warnings.length > 0 && (
        <Alert severity="warning">
          <strong>{warnings.length} warning</strong> (soft limit reached or throttling)
          <ul style={{ margin: 0, paddingLeft: 20 }}>{list(warnings)}</ul>
        </Alert>
      )}
    </Box>
  );
}

/* ---------- editor ---------- */

function EditDialog({
  unit,
  state,
  persistDefault,
  onClose,
  onApplied,
}: {
  unit: MemUnit;
  state: AgentResourceState;
  persistDefault: boolean;
  onClose: () => void;
  onApplied: (message: string) => void;
}) {
  const settings = useSettings();
  const fields = editableFields(unit);
  const [form, setForm] = React.useState<EditForm>(() =>
    Object.fromEntries(fields.map(f => [f, sizeInput(currentValue(unit, f) as number | null)]))
  );
  // Slices are always persisted by the backend; scopes are transient.
  const persist = unit.kind === 'slice' && persistDefault;
  const [force, setForce] = React.useState(false);
  const [reason, setReason] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [serverError, setServerError] = React.useState<string | null>(null);

  const ctx = {
    minLimit: state.minLimit,
    hostTotal: state.host.total,
    protectedUnits: state.protected,
    agentSlice: state.agentSlice,
    agentSlices: agentSlices(state),
  };
  const check = checkEdit(unit, form, persist, ctx);
  const canSubmit = check.errors.length === 0 && (!check.belowCurrent || force) && !busy;

  const preset = () => {
    setForm(f => ({
      ...f,
      memoryHigh: state.policy.heavyHigh,
      memoryMax: state.policy.heavyMax,
      memorySwapMax: state.policy.heavySwap,
    }));
  };

  const submit = async () => {
    setBusy(true);
    setServerError(null);
    try {
      await applyLimits(settings, {
        unit: unit.name,
        changes: check.changes,
        persist,
        force,
        reason,
      });
      const summary = Object.entries(check.changes)
        .map(([k, v]) => `${FIELD_LABELS[k as EditField].split(' (')[0]} ${v}`)
        .join(', ');
      onApplied(
        `Applied ${unitLabel(unit)}: ${summary} (${
          unit.kind === 'slice' ? 'persistent' : 'this agent, until it ends'
        })`
      );
    } catch (e: any) {
      setServerError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onClose={busy ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Edit limits: {unitLabel(unit)}</DialogTitle>
      <DialogContent>
        <Box display="flex" flexDirection="column" gap={2} mt={1}>
          <Typography variant="body2" color="text.secondary">
            Currently {formatSize(unit.current)} in use. Sizes accept K, M, G and T (binary) or
            &quot;infinity&quot;. Changes apply to the running unit straight away.
          </Typography>
          {unit.kind === 'slice' ? (
            <Alert severity="info">
              Saved persistently: systemd writes{' '}
              <code>~/.config/systemd/user.control/{unit.name}.d/50-MemoryHigh.conf</code> and{' '}
              <code>50-MemoryMax.conf</code>, which override T3&apos;s own runtime values. This is
              the limit for all agents together.
            </Alert>
          ) : (
            <Alert severity="info">
              Only this agent, until it ends. New agents start with the default for every agent. A
              daemon-reload on the host resets this to the default; a default change made on this
              page puts it back.
            </Alert>
          )}
          {unit.kind !== 'slice' && (
            <Box>
              <Button size="small" onClick={preset}>
                Use heavy-job guidance
              </Button>
            </Box>
          )}
          {fields.map(f => {
            const cur = currentValue(unit, f);
            const parsed = parseSize(form[f] ?? '');
            return (
              <TextField
                key={f}
                label={FIELD_LABELS[f]}
                value={form[f] ?? ''}
                onChange={e => setForm(prev => ({ ...prev, [f]: e.target.value }))}
                helperText={`Currently ${formatSize(cur as number | null)}${
                  parsed !== undefined && parsed !== null ? `; new value ${formatSize(parsed)}` : ''
                }`}
                error={form[f] !== undefined && parsed === undefined}
                size="small"
                fullWidth
              />
            );
          })}
          <TextField
            label="Reason (recorded in the audit log)"
            value={reason}
            onChange={e => setReason(e.target.value)}
            size="small"
            inputProps={{ maxLength: 200 }}
            fullWidth
          />
          {check.errors.map(msg => (
            <Alert key={msg} severity="error">
              {msg}
            </Alert>
          ))}
          {check.belowCurrent && check.errors.length === 0 && (
            <Alert severity="warning">
              <Box>
                The new hard limit is below current usage. The kernel will kill processes in this
                unit to meet it.
              </Box>
              <FormControlLabel
                control={<Checkbox checked={force} onChange={e => setForce(e.target.checked)} />}
                label="I understand, apply it anyway"
              />
            </Alert>
          )}
          {serverError && <Alert severity="error">{serverError}</Alert>}
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button variant="contained" onClick={submit} disabled={!canSubmit}>
          {busy ? 'Applying...' : 'Apply'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

/* ---------- per-agent default ---------- */

function DefaultsDialog({
  o,
  current,
  state,
  onClose,
  onApplied,
}: {
  o: Orchestrator;
  current: AgentDefault;
  state: AgentResourceState;
  onClose: () => void;
  onApplied: (message: string) => void;
}) {
  const settings = useSettings();
  // The CPU limit is offered when the backend reports one, in the default file or the policy.
  const cpuQuota = effectiveCpuQuota(o);
  const showCpu = cpuQuota !== undefined;
  const [form, setForm] = React.useState<DefaultForm>(() => ({
    memoryHigh: current.memoryHigh === undefined ? '' : sizeInput(current.memoryHigh),
    memoryMax: current.memoryMax === undefined ? '' : sizeInput(current.memoryMax),
    memorySwapMax: current.memorySwapMax === undefined ? '' : sizeInput(current.memorySwapMax),
    ...(showCpu ? { cpuQuota: cpuInput(cpuQuota) } : {}),
  }));
  const [force, setForce] = React.useState(false);
  const [reason, setReason] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [serverError, setServerError] = React.useState<string | null>(null);
  const agents = orchestratorAgents(state.units, o);
  const reload = current.apply !== 'running-agents';
  const check = checkDefaults(
    showCpu ? { ...current, cpuQuota } : current,
    form,
    { minLimit: state.minLimit, hostTotal: state.host.total, hostCpus: state.host.cpus },
    agents,
    state.overrides
  );
  const canSubmit =
    check.errors.length === 0 && (check.belowCurrent.length === 0 || force) && !busy;
  const submit = async () => {
    setBusy(true);
    setServerError(null);
    try {
      const res = await applyDefaults(settings, {
        orchestrator: o.fromBackend ? o.name : undefined,
        changes: check.changes,
        force,
        reason,
      });
      const again = Array.isArray(res?.reapplied) ? res.reapplied.length : 0;
      onApplied(
        `Default for every ${o.title} agent: ${Object.entries(check.changes)
          .map(([k, v]) =>
            k === 'cpuQuota'
              ? `CPU limit ${quotaText(v)}`
              : `${defaultFieldLabel(k).split(' (')[0]} ${v}`
          )
          .join(', ')}. Saved and applied to running agents${
          again ? `; ${again} agent limit${again === 1 ? '' : 's'} set here re-applied` : ''
        }.`
      );
    } catch (e: any) {
      setServerError(describeError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onClose={busy ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Default limit for every {o.title} agent</DialogTitle>
      <DialogContent>
        <Box display="flex" flexDirection="column" gap={2} mt={1}>
          <Typography variant="body2" color="text.secondary">
            Saved in <code>{current.file}</code>
            {reload
              ? ", then the host's systemd user manager reloads (daemon-reload)."
              : ', and set on each running agent now.'}{' '}
            New agents start with this, and running agents get it too, except those with a limit of
            their own set on this page. Nothing is restarted.
          </Typography>
          {(['memoryHigh', 'memoryMax', 'memorySwapMax'] as const).map(f => {
            const parsed = parseSize(form[f] ?? '');
            return (
              <TextField
                key={f}
                label={FIELD_LABELS[f]}
                value={form[f] ?? ''}
                onChange={e => setForm(prev => ({ ...prev, [f]: e.target.value }))}
                helperText={`Currently ${
                  current[f] === undefined ? 'not set' : formatSize(current[f] as number | null)
                }${
                  parsed !== undefined && parsed !== null ? `; new value ${formatSize(parsed)}` : ''
                }`}
                error={!!form[f] && parsed === undefined}
                size="small"
                fullWidth
              />
            );
          })}
          {showCpu && (
            <TextField
              label={CPU_QUOTA_LABEL}
              value={form.cpuQuota ?? ''}
              onChange={e => setForm(prev => ({ ...prev, cpuQuota: e.target.value }))}
              helperText={`Cores for each agent: 16, 1600% or none. Currently ${quotaText(
                cpuQuota
              )}${
                state.host.cpus ? `. The host has ${state.host.cpus} CPUs` : ''
              }. A running agent is throttled, never stopped, when it reaches the limit.`}
              error={!!form.cpuQuota && parseCpuQuota(form.cpuQuota) === undefined}
              size="small"
              fullWidth
            />
          )}
          <TextField
            label="Reason (recorded in the file and the audit log)"
            value={reason}
            onChange={e => setReason(e.target.value)}
            size="small"
            inputProps={{ maxLength: 160 }}
            fullWidth
          />
          {check.errors.map(msg => (
            <Alert key={msg} severity="error">
              {msg}
            </Alert>
          ))}
          {check.belowCurrent.length > 0 && check.errors.length === 0 && (
            <Alert severity="warning">
              <Box>
                The new hard limit is below the usage of{' '}
                {check.belowCurrent
                  .map(u => `${unitLabel(u)} (${formatSize(u.current)})`)
                  .join(', ')}
                . The kernel will kill processes in those agents to meet it.
              </Box>
              <FormControlLabel
                control={<Checkbox checked={force} onChange={e => setForce(e.target.checked)} />}
                label="I understand, apply it anyway"
              />
            </Alert>
          )}
          {serverError && <Alert severity="error">{serverError}</Alert>}
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button variant="contained" onClick={submit} disabled={!canSubmit}>
          {busy ? 'Applying...' : 'Apply'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function DefaultsPanel({
  o,
  writable,
  onEdit,
}: {
  o: Orchestrator;
  writable: boolean;
  onEdit: () => void;
}) {
  const d = o.defaults;
  if (!d) return null;
  const cpu = effectiveCpuQuota(o);
  return (
    <Box display="flex" gap={1} flexWrap="wrap" alignItems="center" mb={2}>
      <Typography variant="subtitle2">Default for every {o.title} agent:</Typography>
      <Chip
        label={`soft ${limitText(d.memoryHigh)}, hard ${limitText(d.memoryMax)}${
          d.memorySwapMax !== undefined ? `, swap ${limitText(d.memorySwapMax)}` : ''
        }${cpu !== undefined ? `, CPU ${quotaText(cpu)}` : ''}`}
      />
      <Tooltip title={[d.file, d.note].filter(Boolean).join(' · ')}>
        <Typography variant="caption" color="text.secondary">
          {d.file.split('/').slice(-2).join('/')}
        </Typography>
      </Tooltip>
      {d.error && <Chip color="warning" label={`Unreadable: ${d.error}`} />}
      {d.readOnly && <Chip size="small" variant="outlined" label="read-only here" />}
      {writable && !d.error && !d.readOnly && (
        <Button
          size="small"
          onClick={onEdit}
          aria-label={`Edit the default limit for every ${o.title} agent`}
        >
          Edit default
        </Button>
      )}
    </Box>
  );
}

const QOS_LABEL: Record<string, string> = {
  guaranteed: 'Guaranteed',
  burstable: 'Burstable',
  besteffort: 'BestEffort',
};

/** Memory of the node's Kubernetes pods by QoS class, next to the agents. */
function PodsPanel({ state }: { state: AgentResourceState }) {
  const p = state.pods;
  if (!p || p.error) return null;
  return (
    <Box display="flex" gap={1} flexWrap="wrap" alignItems="center" mb={2}>
      <Typography variant="subtitle2">
        Pods on {state.node || 'this node'}: {formatSize(p.current)} of {formatSize(p.max)}
      </Typography>
      {p.classes.map(c => (
        <Tooltip
          key={c.class}
          title={`programs ${formatSize(c.anon)}, page cache ${formatSize(c.file)}`}
        >
          <Chip
            variant="outlined"
            label={`${QOS_LABEL[c.class] ?? c.class}: ${formatSize(c.current)} (${c.pods} pod${
              c.pods === 1 ? '' : 's'
            })`}
          />
        </Tooltip>
      ))}
    </Box>
  );
}

/* ---------- page ---------- */

function ChangesList({ changes }: { changes: ChangeRecord[] }) {
  if (changes.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary">
        No limit has been changed since the backend started.
      </Typography>
    );
  }
  return (
    <Table size="small">
      <TableHead>
        <TableRow>
          <TableCell>Time</TableCell>
          <TableCell>Name</TableCell>
          <TableCell>Change</TableCell>
          <TableCell>Via</TableCell>
          <TableCell>Reason</TableCell>
        </TableRow>
      </TableHead>
      <TableBody>
        {changes.slice(0, 20).map((c, i) => (
          <TableRow key={`${c.time}-${i}`} sx={c.error ? { bgcolor: 'error.light' } : undefined}>
            <TableCell>{new Date(c.time).toLocaleString()}</TableCell>
            <TableCell>
              <Tooltip title={c.unit}>
                <span>{changeLabel(c)}</span>
              </Tooltip>
            </TableCell>
            <TableCell>{describeChange(c)}</TableCell>
            <TableCell>
              {c.method}, {c.runtime ? 'this agent' : 'persistent'}
            </TableCell>
            <TableCell>{c.reason || '-'}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

const GUIDE_WIDTH = 24;
/** Distance from the row top to the elbow: the middle of the first text line. */
const ELBOW_TOP = 20;

/** Fixed-width connector boxes: continuing lines, tees and elbows drawn with borders. */
function Guides({ cells }: { cells: GuideCell[] }) {
  return (
    <>
      {cells.map((c, i) => (
        <Box
          key={i}
          aria-hidden
          sx={{
            position: 'relative',
            flex: 'none',
            alignSelf: 'stretch',
            width: GUIDE_WIDTH,
            ...(c !== 'none' && {
              '&::before': {
                content: '""',
                position: 'absolute',
                left: '50%',
                top: 0,
                bottom: c === 'elbow' ? `calc(100% - ${ELBOW_TOP}px)` : 0,
                borderLeft: '1px solid',
                borderColor: 'text.disabled',
              },
            }),
            ...((c === 'tee' || c === 'elbow') && {
              '&::after': {
                content: '""',
                position: 'absolute',
                left: '50%',
                right: 2,
                top: ELBOW_TOP,
                borderTop: '1px solid',
                borderColor: 'text.disabled',
              },
            }),
          }}
        />
      ))}
    </>
  );
}

/** Line cells that continue past a row to whatever sits below it. */
function continuing(row: AgentTreeRow): GuideCell[] {
  return [...row.guides.map((g): GuideCell => (g ? 'line' : 'none')), row.last ? 'none' : 'line'];
}

/** The table: memory columns, then the five CPU columns, then alerts and the edit button. */
const COLUMNS = TREE_COLUMN_WIDTHS.length;
const CPU_COLUMNS = 5;
/** Index of the first CPU column (CPU use). */
const COL_CPU = 10;

/**
 * The first cell of a row: connectors on the left spanning the full row
 * height, the toggle and label on one line, and an optional caption that
 * starts at the label's left edge.
 */
function TreeCell({
  cells,
  lead,
  caption,
  children,
  bold,
}: {
  cells: GuideCell[];
  lead: React.ReactNode;
  caption?: React.ReactNode;
  children: React.ReactNode;
  bold?: boolean;
}) {
  return (
    <TableCell
      sx={{
        p: 0,
        fontWeight: bold ? 600 : 400,
        position: 'relative',
        minWidth: 340,
        maxWidth: 420,
      }}
    >
      <Box sx={{ position: 'absolute', top: 0, bottom: -1, left: 0, display: 'flex' }}>
        <Guides cells={cells} />
      </Box>
      <Box
        sx={{
          pl: `${cells.length * GUIDE_WIDTH}px`,
          pr: 1,
          py: '8px',
          display: 'flex',
          alignItems: 'flex-start',
          gap: 0.5,
        }}
      >
        <Box sx={{ flex: 'none', width: 24, height: 24 }}>{lead}</Box>
        <Box sx={{ minWidth: 0, flex: 1 }}>
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              flexWrap: 'nowrap',
              gap: 0.5,
              minHeight: 24,
              minWidth: 0,
              '& .MuiChip-root': { flexShrink: 0 },
            }}
          >
            {children}
          </Box>
          {caption && (
            <Typography variant="caption" color="text.secondary" display="block" noWrap>
              {caption}
            </Typography>
          )}
        </Box>
      </Box>
    </TableCell>
  );
}

/** A label that shrinks with an ellipsis instead of wrapping; the tooltip carries the full text. */
const LABEL_SX = {
  minWidth: 0,
  flex: '0 1 auto',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
} as const;

function GroupToggle({
  row,
  label,
  onCollapse,
}: {
  row: AgentTreeRow;
  label: string;
  onCollapse: (key: string) => void;
}) {
  return row.hasChildren ? (
    <Chevron
      open={row.expanded}
      label={`${row.expanded ? 'Collapse' : 'Expand'} ${label}`}
      onToggle={() => onCollapse(row.key)}
    />
  ) : (
    <Box sx={{ width: 24, flex: 'none' }} />
  );
}

function usedCell(v: number | undefined) {
  return <TableCell align="right">{v === undefined ? '' : formatSize(v)}</TableCell>;
}

function EmptyCells({ n }: { n: number }) {
  return (
    <>
      {Array.from({ length: n }, (_, i) => (
        <TableCell key={i} />
      ))}
    </>
  );
}

/** The cells of a group row after Used: empty, except the CPU use of the group. */
function GroupRest({ cpu }: { cpu?: number }) {
  return (
    <>
      <EmptyCells n={COL_CPU - 3} />
      <TableCell align="right">{cpu === undefined ? '' : formatCpuUse(cpu)}</TableCell>
      <EmptyCells n={COLUMNS - COL_CPU - 1} />
    </>
  );
}

function OrchestratorInfo({
  o,
  writable,
  onEditDefault,
}: {
  o: Orchestrator;
  writable: boolean;
  onEditDefault: () => void;
}) {
  return (
    <Box py={0.5} pr={1}>
      {o.fromBackend && (
        <Typography variant="caption" color="text.secondary" display="block" mb={0.5}>
          {[
            o.agentsSlice && `agents in ${o.agentsSlice}`,
            o.threadEnv && `thread from ${o.threadEnv}`,
          ]
            .filter(Boolean)
            .join(' · ')}
        </Typography>
      )}
      <PolicyChips o={o} />
      <DriftNote o={o} />
      <DefaultsPanel o={o} writable={writable} onEdit={onEditDefault} />
    </Box>
  );
}

function UnitRow({
  row,
  state,
  byUnit,
  expanded,
  onToggle,
  onEdit,
}: {
  row: AgentTreeRow;
  state: AgentResourceState;
  byUnit: Map<string, MemAlert[]>;
  expanded: ReadonlySet<string>;
  onToggle: (name: string) => void;
  onEdit: (name: string) => void;
}) {
  const u = row.unit as MemUnit;
  const o = state.orchestrators.find(x => x.name === u.orchestrator) ?? state.orchestrators[0];
  const sev = worstSeverity(byUnit.get(u.name));
  const editable = canEdit(u, state);
  const own = state.overrides[u.name] ?? o?.overrides[u.name];
  const hasProcs = processTotal(u) > 0;
  const open = hasProcs && expanded.has(u.name);
  const summary = processSummary(u);
  const agent = isAgent(u);
  const label = agent ? threadName(u) : unitLabel(u);
  const fullLabel = agent ? agentLabel(u) : label;
  const tip = [unitDetail(u), u.agent?.cwd, u.name].filter(Boolean).join(' · ');
  const isAllAgents = u.role === 'agents' || (!u.role && u.name === state.agentSlice);
  return (
    <React.Fragment>
      <TableRow
        hover
        sx={
          sev
            ? {
                bgcolor: sev === 'critical' ? 'error.light' : 'warning.light',
                '& td': { color: 'text.primary' },
              }
            : undefined
        }
      >
        <TreeCell
          cells={guideCells(row)}
          bold={!agent}
          caption={summary}
          lead={
            hasProcs && (
              <Chevron
                open={open}
                label={`${open ? 'Hide' : 'Show'} processes of ${label}`}
                onToggle={() => onToggle(u.name)}
              />
            )
          }
        >
          <Tooltip title={`${fullLabel} · ${tip}`}>
            <Box component="span" sx={LABEL_SX}>
              {agent && (
                <Box component="span" sx={{ color: 'text.secondary', fontWeight: 400 }}>
                  {agentLabelParts(u).project} &gt;{' '}
                </Box>
              )}
              {agent && u.agent?.threadUrl ? (
                <Link
                  href={u.agent.threadUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`Open the thread ${fullLabel}`}
                >
                  {label}
                </Link>
              ) : (
                label
              )}
            </Box>
          </Tooltip>
          {!agent && (
            <Typography
              component="span"
              variant="caption"
              color="text.secondary"
              sx={{ flex: 'none' }}
            >
              {u.kind}
            </Typography>
          )}
          {u.raised && (
            <Tooltip title={raisedTitle(u.raised)}>
              <Chip size="small" color="info" variant="outlined" label="Raised by request" />
            </Tooltip>
          )}
          {own && (
            <Tooltip
              title={`Set on this page: ${Object.entries(own)
                .map(([k, v]) => `${k} ${v}`)
                .join(', ')}. The default does not apply to this agent until it ends.`}
            >
              <Chip size="small" label="Own limit" />
            </Tooltip>
          )}
          {isAllAgents && <Chip size="small" variant="outlined" label="All agents" />}
          {u.role === 'control' && <Chip size="small" variant="outlined" label="Control" />}
        </TreeCell>
        <TableCell>
          <UsageBar unit={u} hostTotal={state.host.total} />
        </TableCell>
        <TableCell align="right">{formatSize(u.current)}</TableCell>
        <TableCell align="right">{u.peak ? formatSize(u.peak) : '-'}</TableCell>
        <TableCell align="right">{formatSize(u.high)}</TableCell>
        <TableCell align="right">{formatSize(u.max)}</TableCell>
        <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
          <Tooltip title={`Swap used / limit: ${swapText(u)}`}>
            <span>{swapText(u)}</span>
          </Tooltip>
        </TableCell>
        <TableCell align="right">{u.events?.oom_kill ?? 0}</TableCell>
        <TableCell>
          <EventChips unit={u} />
        </TableCell>
        <TableCell>
          <Pressure unit={u} />
        </TableCell>
        <CpuCells unit={u} />
        <TableCell>
          <AlertBadges alerts={byUnit.get(u.name)} />
        </TableCell>
        <TableCell sx={{ whiteSpace: 'nowrap' }}>
          {editable && (
            <Button
              size="small"
              onClick={() => onEdit(u.name)}
              aria-label={`Edit limits of ${fullLabel}`}
            >
              Edit
            </Button>
          )}
        </TableCell>
      </TableRow>
      {open && (
        <TableRow>
          <TableCell colSpan={COLUMNS} sx={{ p: 0, bgcolor: 'action.hover' }}>
            <Box display="flex" alignItems="stretch">
              <Guides cells={continuing(row)} />
              <Box sx={{ flex: 1, minWidth: 0, p: 1, pl: 2 }}>
                <ProcessTree unit={u} />
              </Box>
            </Box>
          </TableCell>
        </TableRow>
      )}
    </React.Fragment>
  );
}

/** The whole page as one table so the connector lines run unbroken from row to row. */
function AgentTree({
  state,
  filter,
  byUnit,
  expanded,
  collapsed,
  onToggle,
  onCollapse,
  onEdit,
  onEditDefault,
}: {
  state: AgentResourceState;
  filter: string;
  byUnit: Map<string, MemAlert[]>;
  expanded: ReadonlySet<string>;
  collapsed: ReadonlySet<string>;
  onToggle: (name: string) => void;
  onCollapse: (key: string) => void;
  onEdit: (name: string) => void;
  onEditDefault: (orchestrator: string) => void;
}) {
  const rows = React.useMemo(() => buildTree(state, collapsed, filter), [state, collapsed, filter]);
  return (
    <Table
      size="small"
      aria-label="Agent resource tree"
      sx={{
        tableLayout: 'fixed',
        width: '100%',
        minWidth: TREE_COLUMN_WIDTHS.reduce((a, b) => a + b, 0),
        '& th': { px: 1, whiteSpace: 'nowrap' },
        '& td': { px: 1, overflow: 'hidden', textOverflow: 'ellipsis' },
        '& td:first-of-type': { px: 0 },
      }}
    >
      <colgroup>
        {TREE_COLUMN_WIDTHS.map((w, i) => (
          <col key={i} style={{ width: w }} />
        ))}
      </colgroup>
      <TableHead>
        <TableRow>
          <TableCell>Name</TableCell>
          <TableCell>Usage</TableCell>
          <TableCell align="right">Used</TableCell>
          <TableCell align="right">Peak</TableCell>
          <TableCell align="right">Soft</TableCell>
          <TableCell align="right">Hard</TableCell>
          <TableCell align="right">Swap</TableCell>
          <TableCell align="right">
            <Tooltip title="OOM kills since the cgroup was created (total)">
              <span>OOM kills</span>
            </Tooltip>
          </TableCell>
          <TableCell>
            <Tooltip title="Events in the recent window">
              <span>Events</span>
            </Tooltip>
          </TableCell>
          <TableCell>
            <Tooltip title="Memory stall time in the recent window">
              <span>Mem stall</span>
            </Tooltip>
          </TableCell>
          <TableCell align="right">
            <Tooltip title="CPU cores in use (average between two refreshes)">
              <span>CPU use</span>
            </Tooltip>
          </TableCell>
          <TableCell align="right">
            <Tooltip title="CPU limit of the unit (CPUQuota, in cores)">
              <span>CPU limit</span>
            </Tooltip>
          </TableCell>
          <TableCell align="right">
            <Tooltip title="CPU use as a share of the CPU limit">
              <span>Of limit</span>
            </Tooltip>
          </TableCell>
          <TableCell>
            <Tooltip title="Time spent throttled by the CPU limit between two refreshes (100% is the time of one core), and the number of throttled scheduler periods in total">
              <span>Throttled</span>
            </Tooltip>
          </TableCell>
          <TableCell>
            <Tooltip title="CPU pressure: share of time a task waited for CPU (10 second average)">
              <span>CPU stall</span>
            </Tooltip>
          </TableCell>
          <TableCell>Alerts</TableCell>
          <TableCell />
        </TableRow>
      </TableHead>
      <TableBody>
        {rows.map(row => {
          if (row.kind === 'unit')
            return (
              <UnitRow
                key={row.key}
                row={row}
                state={state}
                byUnit={byUnit}
                expanded={expanded}
                onToggle={onToggle}
                onEdit={onEdit}
              />
            );
          if (row.kind === 'host') {
            const { total, available } = state.host;
            return (
              <TableRow key={row.key} hover>
                <TreeCell
                  cells={[]}
                  bold
                  lead={<GroupToggle row={row} label="the host" onCollapse={onCollapse} />}
                  caption={`${formatSize(available)} of ${formatSize(total)} available`}
                >
                  <Box component="span" sx={LABEL_SX}>
                    Host {state.node || 'unknown'}
                  </Box>
                </TreeCell>
                <TableCell />
                {usedCell(total > 0 ? Math.max(0, total - available) : undefined)}
                <GroupRest />
              </TableRow>
            );
          }
          if (row.kind === 'orchestrator') {
            const o = row.orchestrator as Orchestrator;
            return (
              <React.Fragment key={row.key}>
                <TableRow hover>
                  <TreeCell
                    cells={guideCells(row)}
                    bold
                    lead={<GroupToggle row={row} label={o.title} onCollapse={onCollapse} />}
                  >
                    <Box component="span" sx={LABEL_SX}>
                      {o.title}
                    </Box>
                    <Chip
                      size="small"
                      color={o.running ? 'success' : 'default'}
                      label={
                        o.running ? `${o.agents} agent${o.agents === 1 ? '' : 's'}` : 'not running'
                      }
                    />
                    {o.fromBackend && o.controlUnit && (
                      <Tooltip title={`Control unit ${o.controlUnit}`}>
                        <Chip
                          size="small"
                          variant="outlined"
                          color={o.controlUp ? 'success' : 'default'}
                          label={`${shortName(o.controlUnit)} ${o.controlUp ? 'up' : 'down'}`}
                        />
                      </Tooltip>
                    )}
                    {o.names && !o.names.up && (
                      <Tooltip title={o.names.error ?? ''}>
                        <Chip size="small" color="warning" label="names unavailable" />
                      </Tooltip>
                    )}
                  </TreeCell>
                  <TableCell />
                  {usedCell(o.running ? o.current : undefined)}
                  <GroupRest
                    cpu={
                      o.running
                        ? orchestratorUnits(state.units, o).find(x => x.role === 'agents')?.cpuCores
                        : undefined
                    }
                  />
                </TableRow>
                {row.expanded && (
                  <TableRow>
                    <TableCell colSpan={COLUMNS} sx={{ p: 0, borderBottom: 'none' }}>
                      <Box display="flex" alignItems="stretch">
                        <Guides cells={[...continuing(row), row.hasChildren ? 'line' : 'none']} />
                        <Box sx={{ flex: 1, minWidth: 0, pl: 0.5 }}>
                          <OrchestratorInfo
                            o={o}
                            writable={state.writable}
                            onEditDefault={() => onEditDefault(o.name)}
                          />
                          {!o.running && !row.hasChildren && (
                            <Typography variant="body2" color="text.secondary" pb={1}>
                              {o.title} is not running on this host.
                            </Typography>
                          )}
                        </Box>
                      </Box>
                    </TableCell>
                  </TableRow>
                )}
              </React.Fragment>
            );
          }
          const p = row.project as ProjectGroup;
          return (
            <TableRow key={row.key} hover>
              <TreeCell
                cells={guideCells(row)}
                bold
                lead={<GroupToggle row={row} label={`project ${p.name}`} onCollapse={onCollapse} />}
                caption={`${p.agents} ${p.other ? 'scope' : 'agent'}${p.agents === 1 ? '' : 's'}`}
              >
                <Tooltip title={p.name}>
                  <Box component="span" sx={LABEL_SX}>
                    {p.name}
                  </Box>
                </Tooltip>
              </TreeCell>
              <TableCell />
              {usedCell(p.current)}
              <GroupRest cpu={p.cpu} />
            </TableRow>
          );
        })}
        {rows.length <= 1 && (
          <TableRow>
            <TableCell colSpan={COLUMNS}>
              <Typography variant="body2" color="text.secondary">
                No units match.
              </Typography>
            </TableCell>
          </TableRow>
        )}
      </TableBody>
    </Table>
  );
}

/** The per-agent CPU default: the default file's value, else the policy's. */
function effectiveCpuQuota(o: Orchestrator): string | undefined {
  return o.defaults?.cpuQuota ?? o.policy.agent.cpuQuota;
}

function limitText(v: Limit | undefined): string {
  return v === undefined ? 'not set' : formatSize(v);
}

/** "CPU limit 16 cores, weight 100" from a layer's CPU policy; empty when the layer has none. */
function cpuPolicyText(l: LayerLimits): string {
  const parts: string[] = [];
  if (l.cpuQuota !== undefined) parts.push(`CPU limit ${quotaText(l.cpuQuota)}`);
  if (l.cpuWeight !== undefined) parts.push(`CPU weight ${l.cpuWeight}`);
  return parts.join(', ');
}

function PolicyChips({ o }: { o: Orchestrator }) {
  const { control, agents, agent } = o.policy;
  const parts: [string, string][] = [];
  const memory = (l: LayerLimits) =>
    `soft ${limitText(l.memoryHigh)}, hard ${limitText(l.memoryMax)}, swap ${limitText(
      l.memorySwapMax
    )}`;
  const layer = (name: string, l: LayerLimits) => {
    const hasMemory = l.memoryHigh !== undefined || l.memoryMax !== undefined;
    const text = [hasMemory ? memory(l) : '', cpuPolicyText(l)].filter(Boolean).join(', ');
    if (text) parts.push([name, text]);
  };
  if (control.memoryMin !== undefined || control.memoryLow !== undefined)
    parts.push([
      'Control',
      [
        `min ${limitText(control.memoryMin)}, low ${limitText(control.memoryLow)}${
          control.managedOOMPreference ? `, OOM ${control.managedOOMPreference}` : ''
        }`,
        cpuPolicyText(control),
      ]
        .filter(Boolean)
        .join(', '),
    ]);
  else if (cpuPolicyText(control)) parts.push(['Control', cpuPolicyText(control)]);
  layer('All agents', agents);
  layer('Each agent', agent);
  if (parts.length === 0) return null;
  return (
    <Box display="flex" gap={1} flexWrap="wrap" alignItems="center" mb={1}>
      <Typography variant="subtitle2">Policy:</Typography>
      {parts.map(([k, v]) => (
        <Chip key={k} size="small" variant="outlined" label={`${k}: ${v}`} />
      ))}
    </Box>
  );
}

function DriftNote({ o }: { o: Orchestrator }) {
  if (!o.fromBackend) return null;
  if (o.drift.length === 0)
    return o.running ? (
      <Chip size="small" color="success" label="Live limits match the policy" sx={{ mb: 1 }} />
    ) : null;
  return (
    <Alert severity="warning" sx={{ mb: 1 }}>
      <Box>
        Live limits differ from the policy
        {o.agentDrift > 0 ? ` (${o.agentDrift} agent${o.agentDrift === 1 ? '' : 's'})` : ''}:
      </Box>
      <Box component="ul" sx={{ m: 0, pl: 3 }}>
        {o.drift.slice(0, 8).map(d => (
          <li key={`${d.unit}/${d.property}`}>
            {d.layer}: {shortName(d.unit)} {d.property} is {driftValue(d.property, d.have)}, policy{' '}
            {driftValue(d.property, d.want)}
          </li>
        ))}
        {o.drift.length > 8 && <li>and {o.drift.length - 8} more</li>}
      </Box>
    </Alert>
  );
}

export function AgentResourcePage(): JSX.Element {
  const settings = useSettings();
  const { state, loading, error, refresh } = useAgentResource(settings);
  // The filter and the open and collapsed rows are part of the URL (query, history replace).
  const location = useLocation();
  const history = useHistory();
  const view = React.useMemo(() => parseView(location.search), [location.search]);
  const setView = (next: Partial<ViewState>) =>
    history.replace({
      pathname: location.pathname,
      search: viewSearch(location.search, { ...view, ...next }),
      hash: location.hash,
    });
  const filter = view.filter;
  const expanded = React.useMemo<ReadonlySet<string>>(() => new Set(view.procs), [view.procs]);
  const collapsed = React.useMemo<ReadonlySet<string>>(
    () => new Set(view.collapsed),
    [view.collapsed]
  );
  const toggleExpanded = (name: string) => setView({ procs: toggled(view.procs, name) });
  const toggleCollapsed = (key: string) => setView({ collapsed: toggled(view.collapsed, key) });
  const [editing, setEditing] = React.useState<string | null>(null);
  const [editingDefault, setEditingDefault] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [version, setVersion] = React.useState(0);
  const changes = useChanges(settings, state !== null, version);

  const alerts = React.useMemo(() => visibleAlerts(state?.alerts ?? []), [state]);
  const byUnit = React.useMemo(() => alertsByUnit(alerts), [alerts]);
  const defaultOrch = state?.orchestrators.find(o => o.name === editingDefault) ?? null;
  const labelFor = (name: string) => {
    const u = state?.units.find(x => x.name === name);
    return u ? unitLabel(u) : shortName(name);
  };
  const unit = state?.units.find(u => u.name === editing) ?? null;

  return (
    <SectionBox title="Agent resources">
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Memory and CPU limits of the agents on the agent host as a tree: host, orchestrator (T3
        Code, Herdr), project and thread. Each orchestrator lists its own control unit and the slice
        that holds all its agents, then one scope per agent thread. The bar fills with current
        usage; the amber line is the soft limit (memory.high, where the kernel starts throttling)
        and the red line is the hard limit (memory.max, where it kills). The CPU columns show the
        CPU limit (cpu.max), the use as a share of it, the time spent throttled by it and the CPU
        pressure. A unit at its CPU limit is slowed down, never stopped.
      </Typography>
      {loading && !state && <CircularProgress size={24} />}
      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          Could not reach the agent-resource backend: {error}
        </Alert>
      )}
      {notice && (
        <Alert severity="success" sx={{ mb: 2 }} onClose={() => setNotice(null)}>
          {notice}
        </Alert>
      )}
      {state && (
        <>
          {state.error && (
            <Alert severity="error" sx={{ mb: 2 }}>
              The backend could not read the cgroups: {state.error}
            </Alert>
          )}
          <HostSummary state={state} />
          <PodsPanel state={state} />
          <AlertsPanel alerts={alerts} labelFor={labelFor} />
          <WarningsPanel state={state} />
          <Box display="flex" gap={2} alignItems="center" flexWrap="wrap" mb={1}>
            <TextField
              label="Filter by name, session, thread, directory or command"
              value={filter}
              onChange={e => setView({ filter: e.target.value })}
              size="small"
              sx={{ minWidth: 340 }}
            />
          </Box>
          <AgentTree
            state={state}
            filter={filter}
            byUnit={byUnit}
            expanded={expanded}
            collapsed={collapsed}
            onToggle={toggleExpanded}
            onCollapse={toggleCollapsed}
            onEdit={setEditing}
            onEditDefault={setEditingDefault}
          />
          {state.writable && (
            <Box mt={3}>
              <Typography variant="h6" gutterBottom>
                Recent changes
              </Typography>
              <ChangesList changes={changes} />
            </Box>
          )}
        </>
      )}
      {state && defaultOrch?.defaults && (
        <DefaultsDialog
          o={defaultOrch}
          current={defaultOrch.defaults}
          state={state}
          onClose={() => setEditingDefault(null)}
          onApplied={message => {
            setEditingDefault(null);
            setNotice(message);
            setVersion(v => v + 1);
            refresh();
          }}
        />
      )}
      {state && unit && (
        <EditDialog
          unit={unit}
          state={state}
          persistDefault
          onClose={() => setEditing(null)}
          onApplied={message => {
            setEditing(null);
            setNotice(message);
            setVersion(v => v + 1);
            refresh();
          }}
        />
      )}
    </SectionBox>
  );
}
