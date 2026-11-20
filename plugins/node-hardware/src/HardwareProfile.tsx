/** "Hardware profile" section of the Node details page, built from the shared inventory snapshot. */
import { NameValueTable, SectionBox, SimpleTable } from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import Alert from '@mui/material/Alert';
import CircularProgress from '@mui/material/CircularProgress';
import Typography from '@mui/material/Typography';
import React from 'react';
import {
  formatBytes,
  formatGhz,
  formatLink,
  HardwareProfile,
  isBelowMax,
  LinkInfo,
  memorySummary,
  PciDevice,
  Slot,
  SLOT_KIND_LABEL,
  slotCounts,
} from './inventory';
import { useInventory } from './inventoryStore';

const dash = (v: string | number | undefined) => (v === undefined || v === '' ? '-' : String(v));

const WARN = 'warning.main';

function LinkCell({ link }: { link: LinkInfo | undefined }): JSX.Element {
  if (!link) {
    return <>-</>;
  }
  const max = isBelowMax(link) ? ` (max ${formatLink(link.maxWidth, link.maxSpeedGts)})` : '';
  return (
    <Typography
      component="span"
      variant="body2"
      sx={{ color: isBelowMax(link) ? WARN : undefined }}
      title={isBelowMax(link) ? 'Running below its maximum link width or speed' : undefined}
    >
      {formatLink(link.width, link.speedGts)}
      {max}
    </Typography>
  );
}

function SubTitle({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <Typography variant="subtitle1" sx={{ mt: 2, mb: 0.5 }}>
      {children}
    </Typography>
  );
}

function Empty({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <Typography variant="body2" color="text.secondary">
      {children}
    </Typography>
  );
}

function BoardTable({ p }: { p: HardwareProfile }): JSX.Element {
  const b = p.board;
  return (
    <>
      <SubTitle>Motherboard</SubTitle>
      <NameValueTable
        rows={[
          { name: 'Vendor', value: dash(b?.vendor) },
          { name: 'Model', value: dash(b?.model) },
          { name: 'Version', value: dash(b?.version) },
          { name: 'BIOS', value: b ? `${dash(b.biosVendor)} ${dash(b.biosVersion)}${b.biosDate ? ` (${b.biosDate})` : ''}` : '-' },
        ]}
      />
    </>
  );
}

function CpuTable({ p }: { p: HardwareProfile }): JSX.Element {
  const c = p.cpu;
  return (
    <>
      <SubTitle>CPU</SubTitle>
      <Typography variant="body2" sx={{ mb: 0.5 }}>
        {c.socketsTotal === undefined ? 'Socket count unknown' : `${c.socketsPopulated ?? '-'} of ${c.socketsTotal} sockets populated`}
      </Typography>
      {c.sockets.length === 0 ? (
        <Empty>No CPU details reported.</Empty>
      ) : (
        <SimpleTable
          data={c.sockets}
          columns={[
            { label: 'Socket', getter: s => s.socket },
            { label: 'Model', getter: s => (s.populated ? dash(s.model) : 'Empty') },
            { label: 'Cores', getter: s => dash(s.cores) },
            { label: 'Threads', getter: s => dash(s.threads) },
            { label: 'Max speed', getter: s => formatGhz(s.maxHz) },
            { label: 'Current speed', getter: s => formatGhz(s.currentHz) },
          ]}
        />
      )}
    </>
  );
}

function MemoryTable({ p }: { p: HardwareProfile }): JSX.Element {
  const m = p.memory;
  return (
    <>
      <SubTitle>Memory</SubTitle>
      <Typography variant="body2" sx={{ mb: 0.5 }}>
        {memorySummary(m)}
        {m.installedFromModules ? '' : ' (installed size is the kernel total)'}
      </Typography>
      <NameValueTable
        rows={[
          { name: 'ECC', value: dash(m.ecc) },
          { name: 'Corrected errors', value: dash(m.correctableErrors) },
          { name: 'Uncorrected errors', value: m.uncorrectableErrors === undefined ? '-' : <span style={{ color: m.uncorrectableErrors > 0 ? 'red' : undefined }}>{m.uncorrectableErrors}</span> },
        ]}
      />
      {m.modules.length === 0 ? (
        <Empty>No per-slot memory details reported.</Empty>
      ) : (
        <SimpleTable
          data={m.modules}
          columns={[
            { label: 'Slot', getter: d => d.locator },
            { label: 'Size', getter: d => (d.empty ? 'Empty' : formatBytes(d.sizeBytes)) },
            { label: 'Type', getter: d => (d.empty ? '-' : dash(`${d.type} ${d.formFactor}`.trim())) },
            { label: 'Rated speed', getter: d => (d.empty || d.ratedMts === undefined ? '-' : `${d.ratedMts} MT/s`) },
            {
              label: 'Configured speed',
              getter: d =>
                d.empty || d.configuredMts === undefined ? (
                  '-'
                ) : (
                  <Typography component="span" variant="body2" sx={{ color: d.ratedMts !== undefined && d.configuredMts < d.ratedMts ? WARN : undefined }}>
                    {d.configuredMts} MT/s
                  </Typography>
                ),
            },
            { label: 'Manufacturer', getter: d => dash(d.manufacturer) },
            { label: 'Part number', getter: d => dash(d.partNumber) },
          ]}
        />
      )}
    </>
  );
}

const deviceName = (d: PciDevice) => `${d.vendor} ${d.device}`.trim() || d.address;

function SlotsTable({ p }: { p: HardwareProfile }): JSX.Element {
  const pcie = slotCounts(p, 'pcie');
  const m2 = slotCounts(p, 'm2');
  return (
    <>
      <SubTitle>Expansion slots</SubTitle>
      {p.slots.length === 0 ? (
        <Empty>No slot information reported.</Empty>
      ) : (
        <>
          <Typography variant="body2" sx={{ mb: 0.5 }}>
            PCIe: {pcie.inUse} of {pcie.total} in use. M.2: {m2.inUse} of {m2.total} in use.
          </Typography>
          <SimpleTable
            data={p.slots}
            columns={[
              { label: 'Slot', getter: (s: Slot) => s.designation },
              { label: 'Kind', getter: (s: Slot) => SLOT_KIND_LABEL[s.kind] },
              { label: 'Type', getter: (s: Slot) => dash(s.slotType) },
              { label: 'Lanes', getter: (s: Slot) => (s.lanes === undefined ? '-' : `x${s.lanes}`) },
              { label: 'Generation', getter: (s: Slot) => (s.generation === undefined ? '-' : `Gen${s.generation}`) },
              { label: 'Status', getter: (s: Slot) => ({ in_use: 'In use', available: 'Free', unknown: '-' })[s.usage] },
              { label: 'Device', getter: (s: Slot) => (s.devices.length > 0 ? s.devices.map(deviceName).join(', ') : '-') },
              { label: 'Link', getter: (s: Slot) => (s.devices[0] ? <LinkCell link={s.devices[0].link} /> : '-') },
            ]}
          />
        </>
      )}
    </>
  );
}

function PciTable({ p }: { p: HardwareProfile }): JSX.Element | null {
  if (p.pciDevices.length === 0) {
    return null;
  }
  const slow = p.pciDevices.filter(d => isBelowMax(d.link)).length;
  return (
    <>
      <SubTitle>PCI devices</SubTitle>
      {slow > 0 && (
        <Alert severity="warning" sx={{ mb: 1 }}>
          {slow} device{slow === 1 ? ' runs' : 's run'} below the maximum PCIe link width or speed.
        </Alert>
      )}
      <SimpleTable
        data={p.pciDevices}
        columns={[
          { label: 'Address', getter: (d: PciDevice) => d.address },
          { label: 'Class', getter: (d: PciDevice) => dash(d.className) },
          { label: 'Device', getter: deviceName },
          { label: 'Driver', getter: (d: PciDevice) => dash(d.driver) },
          { label: 'Slot', getter: (d: PciDevice) => dash(d.slot) },
          { label: 'Link', getter: (d: PciDevice) => <LinkCell link={d.link} /> },
        ]}
      />
    </>
  );
}

function GpuTable({ p }: { p: HardwareProfile }): JSX.Element {
  return (
    <>
      <SubTitle>GPUs</SubTitle>
      {p.gpus.length === 0 ? (
        <Empty>No GPU reported.</Empty>
      ) : (
        <SimpleTable
          data={p.gpus}
          columns={[
            { label: 'Address', getter: g => g.address },
            { label: 'Vendor', getter: g => dash(g.vendor) },
            { label: 'Model', getter: g => dash(g.model) },
            { label: 'VRAM', getter: g => formatBytes(g.vramBytes) },
            { label: 'Driver', getter: g => dash(g.driver) },
            { label: 'Link', getter: g => <LinkCell link={g.link} /> },
          ]}
        />
      )}
    </>
  );
}

function NvmeTable({ p }: { p: HardwareProfile }): JSX.Element {
  return (
    <>
      <SubTitle>NVMe drives</SubTitle>
      {p.nvme.length === 0 ? (
        <Empty>No NVMe drive reported.</Empty>
      ) : (
        <SimpleTable
          data={p.nvme}
          columns={[
            { label: 'Device', getter: n => n.device },
            { label: 'Model', getter: n => dash(n.model) },
            { label: 'Capacity', getter: n => formatBytes(n.capacityBytes) },
            { label: 'Firmware', getter: n => dash(n.firmware) },
            { label: 'Address', getter: n => dash(n.address) },
            { label: 'Link', getter: n => <LinkCell link={n.link} /> },
          ]}
        />
      )}
    </>
  );
}

function ProfileBody({ nodeName }: { nodeName: string }): JSX.Element {
  const { profiles, loading, error } = useInventory();
  if (loading) {
    return <CircularProgress size={24} />;
  }
  if (error && profiles.size === 0) {
    return (
      <Alert severity="error">
        Could not query the metrics service for the hardware profile of {nodeName}: {error}
      </Alert>
    );
  }
  const p = profiles.get(nodeName);
  if (!p) {
    return (
      <Alert severity="info">
        No hardware inventory metrics found for node {nodeName} yet. Check that the node exporter is scraped by the metrics service.
      </Alert>
    );
  }
  return (
    <>
      {error && <Alert severity="warning">Showing the last known data. The latest refresh failed: {error}</Alert>}
      {p.collectorUp === undefined && (
        <Alert severity="info" sx={{ mb: 1 }}>
          The hardware inventory collector is not reporting yet for this node. Slots, per-module memory, PCI devices and drive details need its node_hw_* series. Showing what the existing
          metrics give.
        </Alert>
      )}
      {p.collectorUp === false && (
        <Alert severity="warning" sx={{ mb: 1 }}>
          The last run of the hardware inventory collector failed on this node. Data may be stale or incomplete.
        </Alert>
      )}
      <BoardTable p={p} />
      <CpuTable p={p} />
      <MemoryTable p={p} />
      <SlotsTable p={p} />
      <PciTable p={p} />
      <GpuTable p={p} />
      <NvmeTable p={p} />
    </>
  );
}

export function HardwareProfileSection({ nodeName }: { nodeName: string }): JSX.Element {
  return (
    <SectionBox title="Hardware profile">
      <Typography variant="body2" sx={{ mb: 1 }} color="text.secondary">
        Motherboard, CPU, memory, expansion slots, GPUs and NVMe drives with their maximum capacity and what is in use. Amber means a link or memory module runs below its maximum.
      </Typography>
      <ProfileBody nodeName={nodeName} />
    </SectionBox>
  );
}
