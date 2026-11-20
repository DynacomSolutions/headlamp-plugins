/*
 * Per-node hardware profile: motherboard, CPU, memory, expansion slots, PCI
 * devices, GPUs and NVMe drives. Most series come from the node_hw_* inventory
 * collector (SMBIOS and sysfs, see the README); a few already exist in the
 * cluster (node_dmi_info, node_memory_MemTotal_bytes, node_nvme_info, DCGM,
 * node_edac_*). Every query degrades on its own: a missing series gives "-" in
 * the UI, never a failed profile. All joins happen in code, per node.
 */
/** Same shape as MetricSample in metrics.ts, declared here so the agent build needs no Headlamp types. */
export interface MetricSample {
  metric: Record<string, string>;
  value: [number, string];
}

/** Reads the scalar of a sample. Local copy so this file has no runtime import and the agent can reuse it. */
function numberFromValue(sample: MetricSample | undefined): number | undefined {
  const raw = sample?.value?.[1];
  if (raw === undefined) {
    return undefined;
  }
  const n = Number(raw);
  return Number.isNaN(n) ? undefined : n;
}

export const QUERIES = {
  up: 'node_hw_inventory_up',
  lastRun: 'node_hw_inventory_last_run_timestamp_seconds',
  dmi: 'node_dmi_info',
  cpuInfo: 'node_hw_cpu_info',
  cpuCores: 'node_hw_cpu_cores',
  cpuThreads: 'node_hw_cpu_threads',
  cpuMaxSpeed: 'node_hw_cpu_max_speed_hertz',
  cpuCurSpeed: 'node_hw_cpu_current_speed_hertz',
  cpuSockets: 'node_hw_cpu_sockets',
  memTotal: 'node_memory_MemTotal_bytes',
  memMax: 'node_hw_memory_max_capacity_bytes',
  memSlots: 'node_hw_memory_slots',
  memEcc: 'node_hw_memory_ecc_info',
  memModule: 'node_hw_memory_module_info',
  memModuleSize: 'node_hw_memory_module_size_bytes',
  memModuleSpeed: 'node_hw_memory_module_speed_mts',
  memModuleConfSpeed: 'node_hw_memory_module_configured_speed_mts',
  edacCorrectable: 'sum by (node) (node_edac_correctable_errors_total)',
  edacUncorrectable: 'sum by (node) (node_edac_uncorrectable_errors_total)',
  slotInfo: 'node_hw_slot_info',
  slotLanes: 'node_hw_slot_lanes',
  slotGeneration: 'node_hw_slot_generation',
  pciInfo: 'node_hw_pci_device_info',
  pciWidth: 'node_hw_pci_device_link_width',
  pciMaxWidth: 'node_hw_pci_device_max_link_width',
  pciSpeed: 'node_hw_pci_device_link_speed_gts',
  pciMaxSpeed: 'node_hw_pci_device_max_link_speed_gts',
  gpuInfo: 'node_hw_gpu_info',
  gpuMemory: 'node_hw_gpu_memory_bytes',
  dcgmMemory: 'DCGM_FI_DEV_FB_CAPACITY_BYTES',
  nvmeInfo: 'node_hw_nvme_info',
  nvmeCapacity: 'node_hw_nvme_capacity_bytes',
  nvmeLegacy: 'node_nvme_info',
} as const;

export type InventoryData = Record<keyof typeof QUERIES, MetricSample[]>;

export interface Board {
  vendor: string;
  model: string;
  version: string;
  biosVendor: string;
  biosVersion: string;
  biosDate: string;
}

export interface CpuSocket {
  socket: string;
  model: string;
  populated: boolean;
  cores?: number;
  threads?: number;
  maxHz?: number;
  currentHz?: number;
}

export interface MemoryModule {
  locator: string;
  bank: string;
  sizeBytes: number;
  type: string;
  formFactor: string;
  manufacturer: string;
  partNumber: string;
  ratedMts?: number;
  configuredMts?: number;
  empty: boolean;
}

export interface Memory {
  installedBytes?: number;
  /** True when the installed figure comes from module sizes, false when it is the kernel's MemTotal. */
  installedFromModules: boolean;
  maxBytes?: number;
  slotsTotal?: number;
  slotsUsed?: number;
  ecc?: string;
  modules: MemoryModule[];
  correctableErrors?: number;
  uncorrectableErrors?: number;
}

export interface LinkInfo {
  width?: number;
  maxWidth?: number;
  speedGts?: number;
  maxSpeedGts?: number;
  belowMaxWidth: boolean;
  belowMaxSpeed: boolean;
}

export interface PciDevice {
  address: string;
  className: string;
  vendor: string;
  device: string;
  driver: string;
  slot: string;
  link: LinkInfo;
}

export type SlotKind = 'pcie' | 'm2' | 'other';

export interface Slot {
  designation: string;
  kind: SlotKind;
  slotType: string;
  busAddress: string;
  usage: 'in_use' | 'available' | 'unknown';
  length: string;
  lanes?: number;
  generation?: number;
  devices: PciDevice[];
}

export type GpuKind = 'discrete' | 'integrated' | 'bmc';

export interface Gpu {
  address: string;
  kind: GpuKind;
  vendor: string;
  model: string;
  driver: string;
  vramBytes?: number;
  link?: LinkInfo;
}

export interface NvmeDrive {
  device: string;
  address: string;
  model: string;
  firmware: string;
  capacityBytes?: number;
  link?: LinkInfo;
}

export interface HardwareProfile {
  node: string;
  /** undefined: the inventory collector exports nothing for this node yet. */
  collectorUp?: boolean;
  lastRunSeconds?: number;
  board?: Board;
  cpu: { socketsTotal?: number; socketsPopulated?: number; sockets: CpuSocket[] };
  memory: Memory;
  slots: Slot[];
  pciDevices: PciDevice[];
  gpus: Gpu[];
  nvme: NvmeDrive[];
}

const SPEED_EPSILON = 0.01;

/** Normalises a PCI address: lower case, 4-digit domain ("00000000:01:00.0" becomes "0000:01:00.0"). */
export function normalizePciAddress(address: string): string {
  const a = (address ?? '').trim().toLowerCase();
  const m = /([0-9a-f]{4,8}):([0-9a-f]{2}:[0-9a-f]{2}\.[0-7])$/.exec(a);
  if (m) {
    return `${m[1].slice(-4)}:${m[2]}`;
  }
  return /^[0-9a-f]{2}:[0-9a-f]{2}\.[0-7]$/.test(a) ? `0000:${a}` : a;
}

const GENERATION_BY_GTS: [number, number][] = [[2.5, 1], [5, 2], [8, 3], [16, 4], [32, 5], [64, 6]];

/** PCIe generation for a link speed in GT/s, or undefined when unknown. */
export function pcieGeneration(gts: number | undefined): number | undefined {
  if (gts === undefined) {
    return undefined;
  }
  return GENERATION_BY_GTS.find(([speed]) => Math.abs(speed - gts) < 0.5)?.[1];
}

export function linkInfo(width?: number, maxWidth?: number, speedGts?: number, maxSpeedGts?: number): LinkInfo {
  return {
    width,
    maxWidth,
    speedGts,
    maxSpeedGts,
    belowMaxWidth: width !== undefined && maxWidth !== undefined && width < maxWidth,
    belowMaxSpeed: speedGts !== undefined && maxSpeedGts !== undefined && speedGts < maxSpeedGts - SPEED_EPSILON,
  };
}

/** Only a width below max counts as a problem. Speed drops at idle (ASPM, power states) and is normal. */
export const isBelowMax = (l: LinkInfo | undefined): boolean => !!l && l.belowMaxWidth;

/** Groups samples by their `node` label. Samples without a node are dropped. */
function groupByNode(samples: MetricSample[]): Map<string, MetricSample[]> {
  const result = new Map<string, MetricSample[]>();
  for (const s of samples) {
    const node = s.metric.node;
    if (node) {
      result.set(node, [...(result.get(node) ?? []), s]);
    }
  }
  return result;
}

/** One number per key, from a list of samples of a single node. */
function valuesBy(samples: MetricSample[], label: string): Map<string, number> {
  const result = new Map<string, number>();
  for (const s of samples) {
    const v = numberFromValue(s);
    if (v !== undefined && s.metric[label] !== undefined) {
      result.set(s.metric[label], v);
    }
  }
  return result;
}

const str = (v: string | undefined) => (v ?? '').trim();
const sumOf = (values: Iterable<number>) => [...values].reduce((a, b) => a + b, 0);

function buildBoard(dmi: MetricSample | undefined): Board | undefined {
  if (!dmi) {
    return undefined;
  }
  const m = dmi.metric;
  return {
    vendor: str(m.board_vendor),
    model: str(m.board_name),
    version: str(m.board_version),
    biosVendor: str(m.bios_vendor),
    biosVersion: str(m.bios_version),
    biosDate: str(m.bios_date),
  };
}

function buildCpu(d: Record<string, MetricSample[]>): HardwareProfile['cpu'] {
  const cores = valuesBy(d.cpuCores, 'socket');
  const threads = valuesBy(d.cpuThreads, 'socket');
  const maxHz = valuesBy(d.cpuMaxSpeed, 'socket');
  const curHz = valuesBy(d.cpuCurSpeed, 'socket');
  const counts = valuesBy(d.cpuSockets, 'state');
  const sockets = d.cpuInfo
    .map(s => ({
      socket: str(s.metric.socket),
      model: str(s.metric.model),
      populated: s.metric.populated !== 'false',
      cores: cores.get(s.metric.socket),
      threads: threads.get(s.metric.socket),
      maxHz: maxHz.get(s.metric.socket),
      currentHz: curHz.get(s.metric.socket),
    }))
    .sort((a, b) => a.socket.localeCompare(b.socket, undefined, { numeric: true }));
  return {
    socketsTotal: counts.get('total') ?? (sockets.length > 0 ? sockets.length : undefined),
    socketsPopulated: counts.get('populated') ?? (sockets.length > 0 ? sockets.filter(s => s.populated).length : undefined),
    sockets,
  };
}

function buildMemory(d: Record<string, MetricSample[]>): Memory {
  // Real boards repeat locators across banks, so every module series is keyed by bank and locator.
  const slotKey = (m: Record<string, string>) => `${m.bank ?? ''}|${m.locator ?? ''}`;
  const keyed = (samples: MetricSample[]) => {
    const result = new Map<string, number>();
    for (const s of samples) {
      const v = numberFromValue(s);
      if (v !== undefined) {
        result.set(slotKey(s.metric), v);
      }
    }
    return result;
  };
  const sizes = keyed(d.memModuleSize);
  const rated = keyed(d.memModuleSpeed);
  const configured = keyed(d.memModuleConfSpeed);
  const modules: MemoryModule[] = d.memModule
    .map(s => {
      const locator = str(s.metric.locator);
      const sizeBytes = sizes.get(slotKey(s.metric)) ?? 0;
      return {
        locator,
        bank: str(s.metric.bank),
        sizeBytes,
        type: str(s.metric.type),
        formFactor: str(s.metric.form_factor),
        manufacturer: str(s.metric.manufacturer),
        partNumber: str(s.metric.part_number),
        ratedMts: rated.get(slotKey(s.metric)),
        configuredMts: configured.get(slotKey(s.metric)),
        empty: sizeBytes === 0,
      };
    })
    .sort((a, b) => a.bank.localeCompare(b.bank) || a.locator.localeCompare(b.locator, undefined, { numeric: true }));

  const slotCounts = valuesBy(d.memSlots, 'state');
  const populated = modules.filter(m => !m.empty).length;
  const moduleBytes = sumOf(modules.map(m => m.sizeBytes));
  const memTotal = numberFromValue(d.memTotal[0]);
  const fromModules = moduleBytes > 0;
  return {
    installedBytes: fromModules ? moduleBytes : memTotal,
    installedFromModules: fromModules,
    maxBytes: numberFromValue(d.memMax[0]),
    slotsTotal: slotCounts.get('total') ?? (modules.length > 0 ? modules.length : undefined),
    slotsUsed: slotCounts.get('used') ?? (modules.length > 0 ? populated : undefined),
    ecc: d.memEcc[0] ? str(d.memEcc[0].metric.correction) || undefined : undefined,
    modules,
    correctableErrors: numberFromValue(d.edacCorrectable[0]),
    uncorrectableErrors: numberFromValue(d.edacUncorrectable[0]),
  };
}

function buildPciDevices(d: Record<string, MetricSample[]>): PciDevice[] {
  const width = valuesBy(d.pciWidth, 'address');
  const maxWidth = valuesBy(d.pciMaxWidth, 'address');
  const speed = valuesBy(d.pciSpeed, 'address');
  const maxSpeed = valuesBy(d.pciMaxSpeed, 'address');
  return d.pciInfo
    .map(s => ({
      address: normalizePciAddress(s.metric.address),
      className: str(s.metric.class_name),
      vendor: str(s.metric.vendor),
      device: str(s.metric.device),
      driver: str(s.metric.driver),
      slot: str(s.metric.slot),
      link: linkInfo(width.get(s.metric.address), maxWidth.get(s.metric.address), speed.get(s.metric.address), maxSpeed.get(s.metric.address)),
    }))
    .sort((a, b) => a.address.localeCompare(b.address));
}

/** A device sits in a slot when the collector named the slot, or the bus address matches (function ignored). */
function deviceInSlot(device: PciDevice, slot: Slot): boolean {
  if (device.slot && device.slot === slot.designation) {
    return true;
  }
  const bus = normalizePciAddress(slot.busAddress);
  return bus !== '' && (device.address === bus || device.address.slice(0, -2) === bus.slice(0, -2));
}

function buildSlots(d: Record<string, MetricSample[]>, devices: PciDevice[]): Slot[] {
  const lanes = valuesBy(d.slotLanes, 'designation');
  const generation = valuesBy(d.slotGeneration, 'designation');
  return d.slotInfo
    .map(s => {
      const usage = s.metric.usage;
      const slot: Slot = {
        designation: str(s.metric.designation),
        kind: s.metric.kind === 'pcie' || s.metric.kind === 'm2' ? s.metric.kind : 'other',
        slotType: str(s.metric.slot_type),
        busAddress: str(s.metric.bus_address),
        usage: usage === 'in_use' || usage === 'available' ? usage : 'unknown',
        length: str(s.metric.length),
        lanes: lanes.get(s.metric.designation),
        generation: generation.get(s.metric.designation),
        devices: [],
      };
      slot.devices = devices.filter(dev => deviceInSlot(dev, slot));
      return slot;
    })
    .sort((a, b) => a.designation.localeCompare(b.designation, undefined, { numeric: true }));
}

const GPU_IGPU_MAX_VRAM = 2 * 1024 ** 3;

/** BMC display chips and CPU-integrated GPUs are not counted as discrete cards. */
export function classifyGpu(g: { vendor: string; model: string; driver: string; vramBytes?: number }): GpuKind {
  if (g.driver === 'ast' || g.driver === 'mgag200' || /aspeed|matrox/i.test(g.vendor)) {
    return 'bmc';
  }
  if ((g.driver === 'i915' || g.driver === 'xe') && !/\bArc\b/.test(g.model)) {
    return 'integrated';
  }
  if (/\bAMD\b|Advanced Micro Devices/i.test(g.vendor) && g.vramBytes !== undefined && g.vramBytes <= GPU_IGPU_MAX_VRAM) {
    return 'integrated';
  }
  return 'discrete';
}

function buildGpus(d: Record<string, MetricSample[]>, devices: PciDevice[]): Gpu[] {
  const byAddress = new Map<string, Gpu>();
  const linkOf = (address: string) => devices.find(dev => dev.address === address)?.link;
  for (const s of d.gpuInfo) {
    const address = normalizePciAddress(s.metric.address);
    byAddress.set(address, {
      address,
      kind: 'discrete',
      vendor: str(s.metric.vendor),
      model: str(s.metric.model),
      driver: str(s.metric.driver),
      link: linkOf(address),
    });
  }
  const sysfsVram = new Map(d.gpuMemory.map(s => [normalizePciAddress(s.metric.address), numberFromValue(s)]));
  const dcgmVram = new Map(d.dcgmMemory.map(s => [normalizePciAddress(s.metric.pci_bus_id), numberFromValue(s)]));
  // DCGM-only GPUs (NVIDIA) join the union; the collector entry wins on shared fields.
  for (const s of d.dcgmMemory) {
    const address = normalizePciAddress(s.metric.pci_bus_id);
    if (!byAddress.has(address)) {
      byAddress.set(address, { address, kind: 'discrete', vendor: 'NVIDIA', model: str(s.metric.modelName), driver: '', link: linkOf(address) });
    }
  }
  for (const gpu of byAddress.values()) {
    gpu.vramBytes = sysfsVram.get(gpu.address) ?? dcgmVram.get(gpu.address);
    if (!gpu.model) {
      gpu.model = str(d.dcgmMemory.find(s => normalizePciAddress(s.metric.pci_bus_id) === gpu.address)?.metric.modelName);
    }
    gpu.kind = classifyGpu(gpu);
  }
  return [...byAddress.values()].sort((a, b) => a.address.localeCompare(b.address));
}

function buildNvme(d: Record<string, MetricSample[]>, devices: PciDevice[]): NvmeDrive[] {
  const capacity = valuesBy(d.nvmeCapacity, 'device');
  const drives = new Map<string, NvmeDrive>();
  for (const s of d.nvmeLegacy) {
    const device = str(s.metric.device);
    drives.set(device, { device, address: '', model: str(s.metric.model), firmware: str(s.metric.firmware_revision) });
  }
  for (const s of d.nvmeInfo) {
    const device = str(s.metric.device);
    const old = drives.get(device);
    drives.set(device, {
      device,
      address: normalizePciAddress(s.metric.address),
      model: str(s.metric.model) || old?.model || '',
      firmware: str(s.metric.firmware) || old?.firmware || '',
    });
  }
  for (const drive of drives.values()) {
    drive.capacityBytes = capacity.get(drive.device);
    drive.link = devices.find(dev => dev.address === drive.address)?.link;
  }
  return [...drives.values()].sort((a, b) => a.device.localeCompare(b.device, undefined, { numeric: true }));
}

/** Builds one profile per node found in any of the series. Pure: no network. */
export function buildProfiles(data: InventoryData): Map<string, HardwareProfile> {
  const grouped = Object.fromEntries(
    (Object.keys(data) as (keyof InventoryData)[]).map(k => [k, groupByNode(data[k])]),
  ) as Record<keyof InventoryData, Map<string, MetricSample[]>>;
  const nodes = new Set<string>();
  for (const key of Object.keys(grouped) as (keyof InventoryData)[]) {
    for (const node of grouped[key].keys()) {
      nodes.add(node);
    }
  }

  const result = new Map<string, HardwareProfile>();
  for (const node of [...nodes].sort()) {
    const d = Object.fromEntries((Object.keys(grouped) as (keyof InventoryData)[]).map(k => [k, grouped[k].get(node) ?? []])) as Record<string, MetricSample[]>;
    const pciDevices = buildPciDevices(d);
    const up = numberFromValue(d.up[0]);
    result.set(node, {
      node,
      collectorUp: up === undefined ? undefined : up === 1,
      lastRunSeconds: numberFromValue(d.lastRun[0]),
      board: buildBoard(d.dmi[0]),
      cpu: buildCpu(d),
      memory: buildMemory(d),
      slots: buildSlots(d, pciDevices),
      pciDevices,
      gpus: buildGpus(d, pciDevices),
      nvme: buildNvme(d, pciDevices),
    });
  }
  return result;
}

const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];

/** Binary size, e.g. 137438953472 gives "128 GiB". */
export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes)) {
    return '-';
  }
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < UNITS.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${Number.isInteger(v) ? v : v.toFixed(1)} ${UNITS[i]}`;
}

export function formatGhz(hz: number | undefined): string {
  return hz === undefined ? '-' : `${(hz / 1e9).toFixed(2)} GHz`;
}

/** Slot label for a memory module: "bank / locator" when the bank is known. */
export const moduleLabel = (m: { bank: string; locator: string }): string => (m.bank ? `${m.bank} / ${m.locator}` : m.locator);

/** "Gen4 x2 (16 GT/s) (max x4)": the maximum is added when the width or the speed runs below it. */
export function formatLinkWithMax(l: LinkInfo): string {
  const base = formatLink(l.width, l.speedGts);
  const gen = pcieGeneration(l.maxSpeedGts);
  const parts: string[] = [];
  if (l.belowMaxSpeed) {
    parts.push(gen ? `Gen${gen}` : `${l.maxSpeedGts} GT/s`);
  }
  if (l.belowMaxWidth) {
    parts.push(`x${l.maxWidth}`);
  }
  return parts.length > 0 ? `${base} (max ${parts.join(' ')})` : base;
}

/** PCIe and M.2 slot counts for the summary line. Firmware often lists fewer M.2 slots than exist. */
export function m2Summary(p: HardwareProfile): string {
  const m2 = slotCounts(p, 'm2');
  if (p.nvme.length > m2.total) {
    return `M.2: ${m2.total} listed by firmware, ${p.nvme.length} NVMe drives installed`;
  }
  return `M.2: ${m2.inUse} of ${m2.total} in use`;
}

export function formatLink(width: number | undefined, gts: number | undefined): string {
  if (width === undefined && gts === undefined) {
    return '-';
  }
  const gen = pcieGeneration(gts);
  return `${gen ? `Gen${gen} ` : ''}x${width ?? '?'}${gts === undefined ? '' : ` (${gts} GT/s)`}`;
}

/** "128 GiB of 512 GiB max, 4 of 8 slots used" with "-" for what is unknown. */
export function memorySummary(m: Memory): string {
  const slots = m.slotsTotal === undefined ? '' : `, ${m.slotsUsed ?? '-'} of ${m.slotsTotal} slots used`;
  return `${formatBytes(m.installedBytes)} of ${formatBytes(m.maxBytes)} max${slots}`;
}

/** Nodes-list RAM cell: "128 / 512 GiB" when both sizes share a unit, else both with units. */
export function ramColumn(p: HardwareProfile | undefined): { text: string; tooltip: string; sortValue: number } | undefined {
  const m = p?.memory;
  if (!m || m.installedBytes === undefined) {
    return undefined;
  }
  const installed = formatBytes(m.installedBytes);
  let text = installed;
  if (m.maxBytes !== undefined) {
    const max = formatBytes(m.maxBytes);
    const [iNum, iUnit] = installed.split(' ');
    text = iUnit === max.split(' ')[1] ? `${iNum} / ${max}` : `${installed} / ${max}`;
  }
  const slots = m.slotsTotal === undefined ? 'Slot count unknown' : `${m.slotsUsed ?? '-'} of ${m.slotsTotal} slots used`;
  const source = m.installedFromModules ? '' : ' (kernel total, module sizes not reported)';
  return { text, tooltip: `${slots}${source}`, sortValue: m.installedBytes };
}

export const GPU_KIND_LABEL: Record<GpuKind, string> = { discrete: 'Discrete', integrated: 'Integrated', bmc: 'BMC display' };

/** Nodes-list GPUs cell: discrete count (plus integrated), every GPU with its kind in the tooltip. */
export function gpuColumn(p: HardwareProfile | undefined): { count: number; text: string; tooltip: string } | undefined {
  if (!p) {
    return undefined;
  }
  const count = p.gpus.filter(g => g.kind === 'discrete').length;
  const igpu = p.gpus.filter(g => g.kind === 'integrated').length;
  const text = igpu > 0 ? `${count} (+${igpu} iGPU)` : String(count);
  let tooltip: string;
  if (p.gpus.length === 0) {
    tooltip = 'No GPU reported';
  } else if (p.gpus.every(g => g.kind === 'bmc')) {
    tooltip = 'BMC display only';
  } else {
    tooltip = p.gpus
      .map(g => {
        const vram = g.vramBytes !== undefined ? `${formatBytes(g.vramBytes)}, ` : '';
        return `${g.model || 'Unknown GPU'} (${vram}${GPU_KIND_LABEL[g.kind].toLowerCase()})`;
      })
      .join(', ');
  }
  return { count, text, tooltip };
}

export const SLOT_KIND_LABEL: Record<SlotKind, string> = { pcie: 'PCIe', m2: 'M.2', other: 'Other' };

/** Total and in-use slot counts for one kind, from the slot list. */
export function slotCounts(p: HardwareProfile, kind: SlotKind): { total: number; inUse: number } {
  const list = p.slots.filter(s => s.kind === kind);
  return { total: list.length, inUse: list.filter(s => s.usage === 'in_use').length };
}

/** Compact, JSON-friendly summary used by tests and documentation of the shape. */
export function summarizeProfile(p: HardwareProfile) {
  return {
    node: p.node,
    collector: p.collectorUp === undefined ? 'not reporting' : p.collectorUp ? 'ok' : 'failed',
    board: p.board ? `${p.board.vendor} ${p.board.model}`.trim() : null,
    cpu: p.cpu.sockets.filter(s => s.populated).map(s => s.model),
    memory: memorySummary(p.memory),
    pcieSlots: slotCounts(p, 'pcie'),
    m2Slots: slotCounts(p, 'm2'),
    gpus: p.gpus.map(g => `${g.model}${g.vramBytes !== undefined ? ` ${formatBytes(g.vramBytes)}` : ''} (${g.kind})`),
    discreteGpus: p.gpus.filter(g => g.kind === 'discrete').length,
    nvme: p.nvme.map(n => `${n.model} ${formatBytes(n.capacityBytes)}`),
    belowMaxLinks: p.pciDevices.filter(d => isBelowMax(d.link)).map(d => `${d.address} ${d.device}`),
  };
}
