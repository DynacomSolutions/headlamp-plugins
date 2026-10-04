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
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import React from 'react';
import { applyLimits, describeError, useAgentMemory, useChanges, useSettings } from './data';
import {
  AgentMemoryState,
  alertsByUnit,
  barGeometry,
  ChangeRecord,
  checkEdit,
  currentValue,
  editableFields,
  EditField,
  EditForm,
  FIELD_LABELS,
  formatSize,
  MemAlert,
  MemUnit,
  parseSize,
  shortName,
  sizeInput,
  worstSeverity,
} from './model';

const LEVEL_COLOUR = {
  ok: 'success.main',
  warning: 'warning.main',
  critical: 'error.main',
} as const;

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
          minWidth: 160,
          borderRadius: 0.5,
          bgcolor: 'action.hover',
          overflow: 'hidden',
        }}
      >
        <Box
          sx={{
            position: 'absolute',
            inset: 0,
            width: `${g.fill}%`,
            bgcolor: LEVEL_COLOUR[g.level],
            opacity: 0.85,
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

function EventChips({ unit }: { unit: MemUnit }) {
  const items: [string, string, boolean][] = [
    ['high', 'soft-limit throttles (memory.events high)', false],
    ['max', 'hard-limit hits (memory.events max)', true],
    ['oom', 'OOM events', true],
    ['oom_kill', 'processes killed by the OOM killer', true],
  ];
  return (
    <Box display="flex" gap={0.5} flexWrap="wrap">
      {items.map(([key, title, severe]) => {
        const n = unit.eventsLocal[key] ?? 0;
        return (
          <Tooltip key={key} title={`${title}: ${n}`}>
            <Chip
              size="small"
              variant={n > 0 ? 'filled' : 'outlined'}
              color={n > 0 ? (severe ? 'error' : 'warning') : 'default'}
              label={`${key.replace('_', ' ')} ${n}`}
            />
          </Tooltip>
        );
      })}
    </Box>
  );
}

function pressureColour(v: number): 'default' | 'warning' | 'error' {
  return v >= 25 ? 'error' : v >= 5 ? 'warning' : 'default';
}

function Pressure({ unit }: { unit: MemUnit }) {
  const some = unit.pressureSome.avg10;
  const full = unit.pressureFull.avg10;
  return (
    <Tooltip title="Memory pressure (PSI), 10 second average: share of time some or all tasks were stalled waiting for memory">
      <Box display="flex" gap={0.5}>
        <Chip
          size="small"
          variant="outlined"
          color={pressureColour(some)}
          label={`some ${some.toFixed(1)}%`}
        />
        <Chip
          size="small"
          variant="outlined"
          color={pressureColour(full)}
          label={`full ${full.toFixed(1)}%`}
        />
      </Box>
    </Tooltip>
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

function HostSummary({ state }: { state: AgentMemoryState }) {
  const { total, available } = state.host;
  const free = total > 0 ? available / total : 1;
  const low = free < state.policy.keepFree;
  return (
    <Box display="flex" gap={1} flexWrap="wrap" alignItems="center" mb={2}>
      <Chip label={`Host ${state.node || 'unknown'}`} />
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
      {!state.writable && <Chip variant="outlined" color="warning" label="Read only" />}
    </Box>
  );
}

function AlertsPanel({ alerts }: { alerts: MemAlert[] }) {
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
        <strong>{a.unit === 'host' ? 'Host' : shortName(a.unit)}</strong>: {a.detail}
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
  state: AgentMemoryState;
  persistDefault: boolean;
  onClose: () => void;
  onApplied: (message: string) => void;
}) {
  const settings = useSettings();
  const fields = editableFields(unit);
  const [form, setForm] = React.useState<EditForm>(() =>
    Object.fromEntries(fields.map(f => [f, sizeInput(currentValue(unit, f) as number | null)]))
  );
  const [persist, setPersist] = React.useState(persistDefault);
  const [force, setForce] = React.useState(false);
  const [reason, setReason] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [serverError, setServerError] = React.useState<string | null>(null);

  const ctx = {
    minLimit: state.minLimit,
    hostTotal: state.host.total,
    protectedUnits: state.protected,
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
      onApplied(`${shortName(unit.name)}: ${summary} (${persist ? 'persistent' : 'runtime'})`);
    } catch (e: any) {
      setServerError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onClose={busy ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Edit limits: {shortName(unit.name)}</DialogTitle>
      <DialogContent>
        <Box display="flex" flexDirection="column" gap={2} mt={1}>
          <Typography variant="body2" color="text.secondary">
            Currently {formatSize(unit.current)} in use. Sizes accept K, M, G and T (binary) or
            &quot;infinity&quot;. Changes apply to the running unit straight away.
            {unit.kind === 'scope' && ' New panes still start with the host default.'}
          </Typography>
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
          {unit.kind === 'slice' && (
            <FormControlLabel
              control={<Checkbox checked={persist} onChange={e => setPersist(e.target.checked)} />}
              label="Persist across restarts of the user manager (otherwise runtime only)"
            />
          )}
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
          <TableCell>Unit</TableCell>
          <TableCell>Change</TableCell>
          <TableCell>Via</TableCell>
          <TableCell>Reason</TableCell>
        </TableRow>
      </TableHead>
      <TableBody>
        {changes.slice(0, 20).map((c, i) => (
          <TableRow key={`${c.time}-${i}`} sx={c.error ? { bgcolor: 'error.light' } : undefined}>
            <TableCell>{new Date(c.time).toLocaleString()}</TableCell>
            <TableCell>{shortName(c.unit)}</TableCell>
            <TableCell>
              {Object.keys(c.new)
                .map(k => `${k.replace('Memory', '')} ${c.old[k] ?? '?'} to ${c.new[k]}`)
                .join(', ')}
              {c.error ? ` (failed: ${c.error})` : ''}
            </TableCell>
            <TableCell>
              {c.method}, {c.runtime ? 'runtime' : 'persistent'}
            </TableCell>
            <TableCell>{c.reason || '-'}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function AgentMemoryPage(): JSX.Element {
  const settings = useSettings();
  const { state, loading, error, refresh } = useAgentMemory(settings);
  const [filter, setFilter] = React.useState('');
  const [editing, setEditing] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [version, setVersion] = React.useState(0);
  const changes = useChanges(settings, state !== null, version);

  const alerts = state?.alerts ?? [];
  const byUnit = React.useMemo(() => alertsByUnit(alerts), [alerts]);
  const q = filter.trim().toLowerCase();
  const rows = (state?.units ?? []).filter(
    u =>
      !q ||
      u.name.toLowerCase().includes(q) ||
      (u.command ?? '').toLowerCase().includes(q) ||
      (u.topProcess ?? '').toLowerCase().includes(q)
  );
  const unit = state?.units.find(u => u.name === editing) ?? null;

  return (
    <SectionBox title="Agent memory">
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Memory restrictions of the agent host&apos;s slices and per-pane scopes. The bar fills with
        current usage; the amber line is the soft limit (memory.high, where the kernel starts
        throttling) and the red line is the hard limit (memory.max, where it kills).
      </Typography>
      {loading && !state && <CircularProgress size={24} />}
      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          Could not reach the agent-memory backend: {error}
        </Alert>
      )}
      {notice && (
        <Alert severity="success" sx={{ mb: 2 }} onClose={() => setNotice(null)}>
          Applied {notice}
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
          <AlertsPanel alerts={alerts} />
          <TextField
            label="Filter by unit or command"
            value={filter}
            onChange={e => setFilter(e.target.value)}
            size="small"
            sx={{ mb: 1, minWidth: 280 }}
          />
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Unit</TableCell>
                <TableCell>Process</TableCell>
                <TableCell>Usage</TableCell>
                <TableCell align="right">Used</TableCell>
                <TableCell align="right">Soft</TableCell>
                <TableCell align="right">Hard</TableCell>
                <TableCell align="right">Swap</TableCell>
                <TableCell>Events</TableCell>
                <TableCell>Pressure</TableCell>
                <TableCell>Alerts</TableCell>
                <TableCell />
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map(u => {
                const sev = worstSeverity(byUnit.get(u.name));
                const editable = state.writable && (u.kind === 'slice' || u.kind === 'scope');
                return (
                  <TableRow
                    key={u.name}
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
                    <TableCell
                      sx={{ pl: 1 + u.depth * 2, fontWeight: u.kind === 'slice' ? 600 : 400 }}
                    >
                      <Tooltip title={u.name}>
                        <span>{shortName(u.name)}</span>
                      </Tooltip>{' '}
                      <Typography component="span" variant="caption" color="text.secondary">
                        {u.kind}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      {u.kind === 'slice' ? (
                        <Typography variant="body2" color="text.secondary">
                          {u.procs > 0 ? `${u.procs} processes` : '-'}
                        </Typography>
                      ) : (
                        <Tooltip title={u.command || ''}>
                          <span>
                            {u.topProcess || '-'}
                            {u.procs > 1 ? ` (+${u.procs - 1})` : ''}
                          </span>
                        </Tooltip>
                      )}
                    </TableCell>
                    <TableCell>
                      <UsageBar unit={u} hostTotal={state.host.total} />
                    </TableCell>
                    <TableCell align="right">{formatSize(u.current)}</TableCell>
                    <TableCell align="right">{formatSize(u.high)}</TableCell>
                    <TableCell align="right">{formatSize(u.max)}</TableCell>
                    <TableCell align="right">
                      {formatSize(u.swapCurrent)} / {formatSize(u.swapMax)}
                    </TableCell>
                    <TableCell>
                      <EventChips unit={u} />
                    </TableCell>
                    <TableCell>
                      <Pressure unit={u} />
                    </TableCell>
                    <TableCell>
                      <AlertBadges alerts={byUnit.get(u.name)} />
                    </TableCell>
                    <TableCell>
                      {editable && (
                        <Button
                          size="small"
                          onClick={() => setEditing(u.name)}
                          aria-label={`Edit limits of ${u.name}`}
                        >
                          Edit
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
              {rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={11}>
                    <Typography variant="body2" color="text.secondary">
                      No units match.
                    </Typography>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
          {state.writable && (
            <Box mt={3}>
              <Typography variant="h6" gutterBottom>
                Recent limit changes
              </Typography>
              <ChangesList changes={changes} />
            </Box>
          )}
        </>
      )}
      {state && unit && (
        <EditDialog
          unit={unit}
          state={state}
          persistDefault={false}
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
