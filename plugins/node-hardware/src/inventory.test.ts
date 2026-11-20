import { describe, expect, it } from 'vitest';
import {
  buildProfiles,
  classifyGpu,
  formatBytes,
  formatLink,
  formatLinkWithMax,
  gpuColumn,
  InventoryData,
  isBelowMax,
  linkInfo,
  m2Summary,
  memorySummary,
  moduleLabel,
  normalizePciAddress,
  QUERIES,
  ramColumn,
  slotCounts,
  summarizeProfile,
} from './inventory';
import type { MetricSample } from './metrics';

const GiB = 1024 ** 3;
const sample = (metric: Record<string, string>, value = 1): MetricSample => ({ metric, value: [0, String(value)] });
const n = { node: 'worker-1' };

const emptyData = (): InventoryData => Object.fromEntries(Object.keys(QUERIES).map(k => [k, []])) as unknown as InventoryData;

function fullData(): InventoryData {
  const d = emptyData();
  d.up = [sample(n, 1)];
  d.dmi = [sample({ ...n, board_vendor: 'Acme', board_name: 'Board X', board_version: 'Rev 2', bios_vendor: 'BiosCo', bios_version: 'F1', bios_date: '01/02/2022' })];
  d.cpuInfo = [sample({ ...n, socket: 'CPU1', model: 'Fake CPU 9000', populated: 'true' }), sample({ ...n, socket: 'CPU2', model: '', populated: 'false' })];
  d.cpuCores = [sample({ ...n, socket: 'CPU1' }, 16)];
  d.cpuThreads = [sample({ ...n, socket: 'CPU1' }, 32)];
  d.cpuMaxSpeed = [sample({ ...n, socket: 'CPU1' }, 4.2e9)];
  d.cpuCurSpeed = [sample({ ...n, socket: 'CPU1' }, 3.1e9)];
  d.cpuSockets = [sample({ ...n, state: 'total' }, 2), sample({ ...n, state: 'populated' }, 1)];
  d.memTotal = [sample(n, 120 * GiB)];
  d.memMax = [sample(n, 512 * GiB)];
  d.memSlots = [sample({ ...n, state: 'total' }, 4), sample({ ...n, state: 'used' }, 2)];
  d.memEcc = [sample({ ...n, correction: 'Multi-bit ECC' })];
  d.memModule = ['A1', 'A2', 'B1', 'B2'].map((locator, i) =>
    sample({ ...n, locator, bank: 'bank', type: i < 2 ? 'DDR5' : '', form_factor: 'DIMM', manufacturer: i < 2 ? 'MemCo' : '', part_number: i < 2 ? 'PN-1' : '', rank: '2' }),
  );
  d.memModuleSize = [sample({ ...n, bank: 'bank', locator: 'A1' }, 64 * GiB), sample({ ...n, bank: 'bank', locator: 'A2' }, 64 * GiB), sample({ ...n, bank: 'bank', locator: 'B1' }, 0), sample({ ...n, bank: 'bank', locator: 'B2' }, 0)];
  d.memModuleSpeed = [sample({ ...n, bank: 'bank', locator: 'A1' }, 5600), sample({ ...n, bank: 'bank', locator: 'A2' }, 5600)];
  d.memModuleConfSpeed = [sample({ ...n, bank: 'bank', locator: 'A1' }, 4800), sample({ ...n, bank: 'bank', locator: 'A2' }, 5600)];
  d.edacCorrectable = [sample(n, 3)];
  d.edacUncorrectable = [sample(n, 0)];
  d.slotInfo = [
    sample({ ...n, designation: 'PCIEX16_1', kind: 'pcie', slot_type: 'x16 PCI Express 5', bus_address: '0000:01:00.0', usage: 'in_use', length: 'long' }),
    sample({ ...n, designation: 'PCIEX4_1', kind: 'pcie', slot_type: 'x4 PCI Express 4', bus_address: '0000:05:00.0', usage: 'available', length: 'short' }),
    sample({ ...n, designation: 'M2_1', kind: 'm2', slot_type: 'M.2', bus_address: '0000:03:00.0', usage: 'in_use', length: 'other' }),
  ];
  d.slotLanes = [sample({ ...n, designation: 'PCIEX16_1' }, 16), sample({ ...n, designation: 'PCIEX4_1' }, 4)];
  d.slotGeneration = [sample({ ...n, designation: 'PCIEX16_1' }, 5)];
  d.pciInfo = [
    sample({ ...n, address: '0000:01:00.0', class: '0300', class_name: 'VGA', vendor: 'GpuCo', device: 'Fake GPU 1', driver: 'fakedrv', slot: 'PCIEX16_1' }),
    sample({ ...n, address: '0000:03:00.0', class: '0108', class_name: 'NVMe', vendor: 'DiskCo', device: 'Fake SSD', driver: 'nvme', slot: '' }),
  ];
  d.pciWidth = [sample({ ...n, address: '0000:01:00.0' }, 8), sample({ ...n, address: '0000:03:00.0' }, 4)];
  d.pciMaxWidth = [sample({ ...n, address: '0000:01:00.0' }, 16), sample({ ...n, address: '0000:03:00.0' }, 4)];
  d.pciSpeed = [sample({ ...n, address: '0000:01:00.0' }, 32), sample({ ...n, address: '0000:03:00.0' }, 16)];
  d.pciMaxSpeed = [sample({ ...n, address: '0000:01:00.0' }, 32), sample({ ...n, address: '0000:03:00.0' }, 16)];
  d.gpuInfo = [sample({ ...n, address: '0000:01:00.0', vendor: 'GpuCo', model: 'Fake GPU 1', driver: 'fakedrv' })];
  d.gpuMemory = [sample({ ...n, address: '0000:01:00.0' }, 16 * GiB)];
  d.nvmeInfo = [sample({ ...n, device: 'nvme0', address: '0000:03:00.0', model: 'Fake SSD', firmware: 'FW1' })];
  d.nvmeCapacity = [sample({ ...n, device: 'nvme0' }, 2000 * 1e9)];
  return d;
}

describe('buildProfiles with a full inventory', () => {
  const p = buildProfiles(fullData()).get('worker-1')!;

  it('reads the board', () => {
    expect(p.board).toMatchObject({ vendor: 'Acme', model: 'Board X', biosVersion: 'F1' });
    expect(p.collectorUp).toBe(true);
  });

  it('joins CPU sockets and keeps empty sockets', () => {
    expect(p.cpu.socketsTotal).toBe(2);
    expect(p.cpu.socketsPopulated).toBe(1);
    expect(p.cpu.sockets[0]).toMatchObject({ socket: 'CPU1', cores: 16, threads: 32, maxHz: 4.2e9, populated: true });
    expect(p.cpu.sockets[1].populated).toBe(false);
  });

  it('sums module sizes and treats size 0 as an empty slot', () => {
    expect(p.memory.installedBytes).toBe(128 * GiB);
    expect(p.memory.installedFromModules).toBe(true);
    expect(p.memory.modules.map(m => m.empty)).toEqual([false, false, true, true]);
    expect(p.memory.modules[0]).toMatchObject({ ratedMts: 5600, configuredMts: 4800, manufacturer: 'MemCo' });
    expect(memorySummary(p.memory)).toBe('128 GiB of 512 GiB max, 2 of 4 slots used');
    expect(p.memory.correctableErrors).toBe(3);
    expect(p.memory.ecc).toBe('Multi-bit ECC');
  });

  it('puts devices in slots by name or bus address', () => {
    const slot = (name: string) => p.slots.find(x => x.designation === name)!;
    const [m2, pcie1, pcie4] = [slot('M2_1'), slot('PCIEX16_1'), slot('PCIEX4_1')];
    expect(m2.designation).toBe('M2_1');
    expect(m2.devices.map(d => d.device)).toEqual(['Fake SSD']);
    expect(pcie1.devices.map(d => d.device)).toEqual(['Fake GPU 1']);
    expect(pcie4.devices).toEqual([]);
    expect(pcie1).toMatchObject({ lanes: 16, generation: 5 });
    expect(pcie4.generation).toBeUndefined();
    expect(slotCounts(p, 'pcie')).toEqual({ total: 2, inUse: 1 });
    expect(slotCounts(p, 'm2')).toEqual({ total: 1, inUse: 1 });
  });

  it('flags a device below its maximum link width', () => {
    const gpu = p.pciDevices.find(d => d.device === 'Fake GPU 1')!;
    expect(gpu.link.belowMaxWidth).toBe(true);
    expect(gpu.link.belowMaxSpeed).toBe(false);
    expect(isBelowMax(gpu.link)).toBe(true);
    expect(isBelowMax(p.pciDevices.find(d => d.device === 'Fake SSD')!.link)).toBe(false);
    expect(summarizeProfile(p).belowMaxLinks).toHaveLength(1);
  });

  it('joins GPU VRAM and NVMe capacity and link', () => {
    expect(p.gpus[0]).toMatchObject({ model: 'Fake GPU 1', vramBytes: 16 * GiB });
    expect(p.nvme[0]).toMatchObject({ device: 'nvme0', model: 'Fake SSD', capacityBytes: 2000 * 1e9 });
    expect(p.nvme[0].link?.width).toBe(4);
  });
});

describe('link flags', () => {
  it('flags a lower speed and ignores unknown values', () => {
    expect(linkInfo(4, 4, 8, 16).belowMaxSpeed).toBe(true);
    expect(isBelowMax(linkInfo(16, 16, 2.5, 32))).toBe(false);
    expect(formatLinkWithMax(linkInfo(16, 16, 2.5, 32))).toBe('Gen1 x16 (2.5 GT/s) (max Gen5)');
    expect(isBelowMax(linkInfo(8, 16, 32, 32))).toBe(true);
    expect(formatLinkWithMax(linkInfo(2, 4, 16, 16))).toBe('Gen4 x2 (16 GT/s) (max x4)');
    expect(formatLinkWithMax(linkInfo(4, 4, 16, 16))).toBe('Gen4 x4 (16 GT/s)');
    expect(isBelowMax(linkInfo(4, 4, 16, 16))).toBe(false);
    expect(isBelowMax(linkInfo(undefined, 4, undefined, undefined))).toBe(false);
    expect(isBelowMax(undefined)).toBe(false);
  });
});

describe('memory modules repeated across banks', () => {
  const d = emptyData();
  const mod = (bank: string, locator: string) => ({ ...n, bank, locator, type: 'DDR4', form_factor: 'DIMM', manufacturer: 'MemCo', part_number: 'PN', rank: '1' });
  d.memModule = [sample(mod('P0 CHANNEL A', 'DIMM 1')), sample(mod('P0 CHANNEL B', 'DIMM 1'))];
  d.memModuleSize = [sample({ ...n, bank: 'P0 CHANNEL A', locator: 'DIMM 1' }, 16 * GiB), sample({ ...n, bank: 'P0 CHANNEL B', locator: 'DIMM 1' }, 32 * GiB)];
  d.memModuleSpeed = [sample({ ...n, bank: 'P0 CHANNEL A', locator: 'DIMM 1' }, 3200), sample({ ...n, bank: 'P0 CHANNEL B', locator: 'DIMM 1' }, 2933)];
  const m = buildProfiles(d).get('worker-1')!.memory;

  it('keeps each bank own size and speed', () => {
    expect(m.modules.map(x => [x.bank, x.sizeBytes, x.ratedMts])).toEqual([
      ['P0 CHANNEL A', 16 * GiB, 3200],
      ['P0 CHANNEL B', 32 * GiB, 2933],
    ]);
    expect(m.installedBytes).toBe(48 * GiB);
    expect(moduleLabel(m.modules[0])).toBe('P0 CHANNEL A / DIMM 1');
    expect(moduleLabel({ bank: '', locator: 'DIMM 1' })).toBe('DIMM 1');
  });
});

describe('M.2 summary', () => {
  it('names the mismatch when NVMe drives outnumber listed M.2 slots', () => {
    const d = fullData();
    d.nvmeInfo.push(sample({ ...n, device: 'nvme1', address: '0000:04:00.0', model: 'Fake SSD 2', firmware: 'FW1' }));
    expect(m2Summary(buildProfiles(d).get('worker-1')!)).toBe('M.2: 1 listed by firmware, 2 NVMe drives installed');
  });

  it('keeps x of y in use otherwise', () => {
    expect(m2Summary(buildProfiles(fullData()).get('worker-1')!)).toBe('M.2: 1 of 1 in use');
  });
});

describe('buildProfiles with only existing metrics', () => {
  const d = emptyData();
  d.dmi = [sample({ ...n, board_vendor: 'Acme', board_name: 'Board X', board_version: '', bios_vendor: 'BiosCo', bios_version: 'F1', bios_date: '' })];
  d.memTotal = [sample(n, 64 * GiB)];
  d.nvmeLegacy = [sample({ ...n, device: 'nvme0', model: 'Fake SSD', firmware_revision: 'FW2' })];
  d.dcgmMemory = [sample({ ...n, pci_bus_id: '00000000:0A:00.0', modelName: 'Fake DC GPU' }, 24 * GiB)];
  const p = buildProfiles(d).get('worker-1')!;

  it('has no collector status and falls back to the kernel memory total', () => {
    expect(p.collectorUp).toBeUndefined();
    expect(p.memory.installedBytes).toBe(64 * GiB);
    expect(p.memory.installedFromModules).toBe(false);
    expect(p.memory.maxBytes).toBeUndefined();
    expect(memorySummary(p.memory)).toBe('64 GiB of - max');
    expect(ramColumn(p)?.text).toBe('64 GiB');
    expect(p.slots).toEqual([]);
  });

  it('takes GPUs from DCGM with a normalised address', () => {
    expect(p.gpus).toEqual([expect.objectContaining({ address: '0000:0a:00.0', model: 'Fake DC GPU', vramBytes: 24 * GiB })]);
    expect(gpuColumn(p)).toEqual({ count: 1, text: '1', tooltip: 'Fake DC GPU (24 GiB, discrete)' });
  });

  it('takes NVMe drives from node_nvme_info without capacity', () => {
    expect(p.nvme[0]).toMatchObject({ device: 'nvme0', model: 'Fake SSD', firmware: 'FW2' });
    expect(p.nvme[0].capacityBytes).toBeUndefined();
  });
});

describe('GPU union', () => {
  it('uses collector data first and DCGM for NVIDIA VRAM', () => {
    const d = emptyData();
    d.gpuInfo = [sample({ ...n, address: '0000:01:00.0', vendor: 'NVIDIA', model: 'Fake GPU 2', driver: 'nvidia' })];
    d.dcgmMemory = [sample({ ...n, pci_bus_id: '00000000:01:00.0', modelName: 'Other name' }, 8 * GiB)];
    const gpus = buildProfiles(d).get('worker-1')!.gpus;
    expect(gpus).toHaveLength(1);
    expect(gpus[0]).toMatchObject({ model: 'Fake GPU 2', vramBytes: 8 * GiB });
  });
});

describe('GPU kinds', () => {
  const gpuInfo = (address: string, vendor: string, model: string, driver: string) =>
    sample({ ...n, address, vendor, model, driver });
  const profileOf = (info: MetricSample[], vram: MetricSample[] = []) => {
    const d = emptyData();
    d.gpuInfo = info;
    d.gpuMemory = vram;
    return buildProfiles(d).get('worker-1');
  };
  const bmc = gpuInfo('0000:03:00.0', 'ASPEED Technology, Inc.', 'ASPEED Graphics Family', 'ast');
  const igpu = gpuInfo('0000:0e:00.0', 'AMD', 'Granite Ridge [Radeon 610M]', 'amdgpu');
  const card = gpuInfo('0000:01:00.0', 'GpuCo', 'Fake GPU 1', 'fakedrv');

  it('classifies BMC, integrated and discrete GPUs', () => {
    expect(classifyGpu({ vendor: 'ASPEED Technology, Inc.', model: 'x', driver: '' })).toBe('bmc');
    expect(classifyGpu({ vendor: 'Fake', model: 'x', driver: 'mgag200' })).toBe('bmc');
    expect(classifyGpu({ vendor: 'Matrox Electronics', model: 'x', driver: '' })).toBe('bmc');
    expect(classifyGpu({ vendor: 'Intel', model: 'UHD Graphics', driver: 'i915' })).toBe('integrated');
    expect(classifyGpu({ vendor: 'Intel', model: 'Arc A380', driver: 'xe' })).toBe('discrete');
    expect(classifyGpu({ vendor: 'AMD', model: 'x', driver: 'amdgpu', vramBytes: 512 * 1024 ** 2 })).toBe('integrated');
    expect(classifyGpu({ vendor: 'AMD', model: 'x', driver: 'amdgpu', vramBytes: 16 * GiB })).toBe('discrete');
    expect(classifyGpu({ vendor: 'AMD', model: 'x', driver: 'amdgpu' })).toBe('discrete');
  });

  it('shows 0 with a BMC-only tooltip on a server without a GPU', () => {
    const p = profileOf([bmc]);
    expect(p?.gpus[0].kind).toBe('bmc');
    expect(gpuColumn(p)).toEqual({ count: 0, text: '0', tooltip: 'BMC display only' });
  });

  it('counts the discrete card and adds the integrated GPU', () => {
    const p = profileOf([card, igpu], [sample({ ...n, address: '0000:0e:00.0' }, 512 * 1024 ** 2), sample({ ...n, address: '0000:01:00.0' }, 16 * GiB)]);
    const c = gpuColumn(p);
    expect(c?.count).toBe(1);
    expect(c?.text).toBe('1 (+1 iGPU)');
    expect(c?.tooltip).toBe('Fake GPU 1 (16 GiB, discrete), Granite Ridge [Radeon 610M] (512 MiB, integrated)');
  });

  it('lists the BMC chip in the tooltip next to a card', () => {
    const c = gpuColumn(profileOf([card, bmc]));
    expect(c?.text).toBe('1');
    expect(c?.tooltip).toContain('ASPEED Graphics Family (bmc display)');
  });
});

describe('nodes and ramColumn', () => {
  it('builds separate profiles per node', () => {
    const d = emptyData();
    d.memTotal = [sample({ node: 'worker-1' }, GiB), sample({ node: 'worker-2' }, 2 * GiB)];
    expect([...buildProfiles(d).keys()]).toEqual(['worker-1', 'worker-2']);
  });

  it('formats installed / max with slots in the tooltip', () => {
    const c = ramColumn(buildProfiles(fullData()).get('worker-1'));
    expect(c?.text).toBe('128 / 512 GiB');
    expect(c?.tooltip).toBe('2 of 4 slots used');
    expect(c?.sortValue).toBe(128 * GiB);
  });

  it('returns undefined for a node without a profile', () => {
    expect(ramColumn(undefined)).toBeUndefined();
    expect(gpuColumn(undefined)).toBeUndefined();
  });
});

describe('formatting', () => {
  it('formats bytes, links and addresses', () => {
    expect(formatBytes(1.5 * GiB)).toBe('1.5 GiB');
    expect(formatBytes(undefined)).toBe('-');
    expect(formatLink(16, 32)).toBe('Gen5 x16 (32 GT/s)');
    expect(formatLink(undefined, undefined)).toBe('-');
    expect(normalizePciAddress('00000000:0A:00.0')).toBe('0000:0a:00.0');
    expect(normalizePciAddress('0a:00.0')).toBe('0000:0a:00.0');
  });
});
