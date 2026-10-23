/*
 * node-hardware: server temperatures and estimated power draw per node, from
 * a Prometheus-compatible metrics service. Adds "Temp" and "Power" columns to
 * the Nodes list and a "Hardware sensors" section to the Node details page.
 */
import { registerDetailsViewSection, registerResourceTableColumnsProcessor } from '@kinvolk/headlamp-plugin/lib';
import { SectionBox } from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import type { ResourceTableColumn } from '@kinvolk/headlamp-plugin/lib/components/common/Resource/ResourceTable';
import Alert from '@mui/material/Alert';
import CircularProgress from '@mui/material/CircularProgress';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import React from 'react';
import { Battery, batteryHealthPct, batterySeverity, columnPower, pickCpuTemps, Severity, tempSeverity } from './hardware';
import { getHardwareSnapshot, startHardwarePolling, useHardware } from './hardwareStore';

const SEVERITY_COLOUR: Record<Severity, string | undefined> = {
  ok: undefined,
  warn: 'warning.main',
  crit: 'error.main',
};

const POWER_NOTE = 'Estimate: CPU package (RAPL) + GPU power. Not wall power.';

const fmtC = (v: number | undefined) => (v === undefined ? '-' : `${v.toFixed(0)} C`);
const fmtW = (v: number | undefined) => (v === undefined ? '-' : `${v.toFixed(0)} W`);

type NodeLike = { jsonData?: { metadata?: { name?: string } }; metadata?: { name?: string } };
const nodeNameOf = (node: NodeLike) => node.jsonData?.metadata?.name || node.metadata?.name || '';

function TempCell({ nodeName }: { nodeName: string }): JSX.Element {
  const { sensors, loading } = useHardware();
  const s = pickCpuTemps(sensors).get(nodeName);
  if (!s) {
    return <Typography display="inline">{loading ? '…' : '-'}</Typography>;
  }
  return (
    <Tooltip title={`${s.chipName || s.chip} ${s.label || s.sensor}`}>
      <Typography display="inline" sx={{ color: SEVERITY_COLOUR[tempSeverity(s.value, s.max, s.crit)] }}>
        {fmtC(s.value)}
      </Typography>
    </Tooltip>
  );
}

function PowerCell({ nodeName }: { nodeName: string }): JSX.Element {
  const { power, loading } = useHardware();
  const c = columnPower(power.get(nodeName));
  if (!c) {
    return <Typography display="inline">{loading ? '…' : '-'}</Typography>;
  }
  return (
    <Tooltip title={c.measured ? 'Measured system power' : POWER_NOTE}>
      <Typography display="inline">{fmtW(c.watts)}</Typography>
    </Tooltip>
  );
}

/** Plain function called during NodeList's render: reads the store, never calls hooks. */
function NodesHardwareColumns({ id, columns }: { id: string; columns: unknown[] }): unknown[] {
  if (id !== 'headlamp-nodes') {
    return columns;
  }
  startHardwarePolling();

  const tempColumn: ResourceTableColumn<NodeLike> = {
    id: 'cpu-temp',
    label: 'Temp',
    gridTemplate: 'min-content',
    disableFiltering: true,
    getValue: node => pickCpuTemps(getHardwareSnapshot().sensors).get(nodeNameOf(node))?.value ?? 0,
    render: node => <TempCell nodeName={nodeNameOf(node)} />,
  };
  const powerColumn: ResourceTableColumn<NodeLike> = {
    id: 'power',
    label: (
      <Tooltip title={POWER_NOTE}>
        <span>Power (est.)</span>
      </Tooltip>
    ) as any,
    gridTemplate: 'min-content',
    disableFiltering: true,
    getValue: node => columnPower(getHardwareSnapshot().power.get(nodeNameOf(node)))?.watts ?? 0,
    render: node => <PowerCell nodeName={nodeNameOf(node)} />,
  };

  // After the built-in memory column, or after disk-health's "disk" column if present.
  const after = Math.max(columns.findIndex((c: any) => c?.id === 'memory'), columns.findIndex((c: any) => c?.id === 'disk'));
  const next = [...columns];
  next.splice(after >= 0 ? after + 1 : columns.length, 0, tempColumn, powerColumn);
  return next;
}

registerResourceTableColumnsProcessor(NodesHardwareColumns as any);

const pct = (v: number | undefined) => (v === undefined ? '-' : `${v.toFixed(0)} %`);
const flag = (v: boolean | undefined) => (v === undefined ? '-' : v ? 'Yes' : 'No');

function BatteryTable({ b }: { b: Battery }): JSX.Element {
  const health = batteryHealthPct(b);
  const charge = b.maxMah ? (100 * (b.currentMah ?? NaN)) / b.maxMah : undefined;
  const rows: [string, React.ReactNode, string?][] = [
    ['Health', pct(health), SEVERITY_COLOUR[batterySeverity(b)]],
    ['Cycles', b.cycles === undefined ? '-' : `${b.cycles} / ${b.designCycles ?? '-'}`],
    ['Charge', pct(Number.isNaN(charge) ? undefined : charge)],
    ['Temperature', fmtC(b.tempC)],
    ['Voltage', b.volts === undefined ? '-' : `${b.volts.toFixed(2)} V`],
    ['Current', b.amps === undefined ? '-' : `${b.amps.toFixed(2)} A`],
    ['Power source', b.external === undefined ? '-' : b.external ? 'AC' : 'Battery'],
    ['Charging', flag(b.charging)],
    ['Permanent failure', flag(b.failure), b.failure ? 'error.main' : undefined],
  ];
  return (
    <>
      <Typography variant="subtitle2" sx={{ mt: 2 }}>
        Battery
      </Typography>
      <Table size="small" sx={{ maxWidth: 360 }}>
        <TableBody>
          {rows.map(([label, value, colour]) => (
            <TableRow key={label}>
              <TableCell>{label}</TableCell>
              <TableCell align="right" sx={{ color: colour }}>
                {value}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </>
  );
}

function HardwareSection({ nodeName }: { nodeName: string }): JSX.Element {
  const { sensors, power, batteries, loading, error } = useHardware();

  if (loading) {
    return <CircularProgress size={24} />;
  }
  if (error) {
    return (
      <Alert severity="error">
        Could not query the metrics service for hardware sensors on {nodeName}: {error}
      </Alert>
    );
  }
  const mine = sensors.filter(s => s.node === nodeName);
  const p = power.get(nodeName);
  const b = batteries.get(nodeName);
  if (mine.length === 0 && !p && !b) {
    return (
      <Alert severity="info">
        No hardware sensor metrics found for node {nodeName} yet. Check that the node exporter hwmon
        collector is enabled and that the metrics service has scraped it at least once.
      </Alert>
    );
  }

  return (
    <>
      {mine.length > 0 && (
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Chip</TableCell>
              <TableCell>Sensor</TableCell>
              <TableCell align="right">Value</TableCell>
              <TableCell align="right">Max</TableCell>
              <TableCell align="right">Crit</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {mine.map(s => (
              <TableRow key={`${s.chip}|${s.sensor}`}>
                <TableCell>{s.chipName || s.chip}</TableCell>
                <TableCell>{s.label || s.sensor}</TableCell>
                <TableCell align="right" sx={{ color: SEVERITY_COLOUR[tempSeverity(s.value, s.max, s.crit)] }}>
                  {fmtC(s.value)}
                </TableCell>
                <TableCell align="right">{fmtC(s.max)}</TableCell>
                <TableCell align="right">{fmtC(s.crit)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <Table size="small" sx={{ mt: 2, maxWidth: 360 }}>
        <TableBody>
          {p?.systemW !== undefined ? (
            <>
              <TableRow>
                <TableCell>System (measured)</TableCell>
                <TableCell align="right">{fmtW(p.systemW)}</TableCell>
              </TableRow>
              <TableRow>
                <TableCell>CPU</TableCell>
                <TableCell align="right">{fmtW(p.cpuW)}</TableCell>
              </TableRow>
            </>
          ) : (
            <TableRow>
              <TableCell>CPU package</TableCell>
              <TableCell align="right">{fmtW(p?.packageW)}</TableCell>
            </TableRow>
          )}
          {p?.dramW !== undefined && (
            <TableRow>
              <TableCell>DRAM</TableCell>
              <TableCell align="right">{fmtW(p.dramW)}</TableCell>
            </TableRow>
          )}
          <TableRow>
            <TableCell>GPU</TableCell>
            <TableCell align="right">{fmtW(p?.gpuW)}</TableCell>
          </TableRow>
          {p?.aneW !== undefined && (
            <TableRow>
              <TableCell>ANE</TableCell>
              <TableCell align="right">{fmtW(p.aneW)}</TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
      {b && <BatteryTable b={b} />}
    </>
  );
}

registerDetailsViewSection(({ resource }) => {
  if (!resource || resource.kind !== 'Node') {
    return null;
  }
  const nodeName: string | undefined = resource.jsonData?.metadata?.name || resource.metadata?.name;
  if (!nodeName) {
    return null;
  }
  return (
    <SectionBox title="Hardware sensors">
      <Typography variant="body2" sx={{ mb: 1 }} color="text.secondary">
        Temperatures and power draw for this node, from the metrics service. {POWER_NOTE}
      </Typography>
      <HardwareSection nodeName={nodeName} />
    </SectionBox>
  );
});
