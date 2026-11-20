import { mkdirSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BoardLayout, BoardShape, layoutBoard, linkText } from './boardLayout';
import { DARK, layoutToSvg,LIGHT } from './boardSvg';
import { HW_TABS, parseHwTab, withHwTab } from './hwTab';
import { Gpu, HardwareProfile, linkInfo, MemoryModule, NvmeDrive, PciDevice, Slot } from './inventory';

const GiB = 1024 ** 3;

const mod = (locator: string, bank: string, gib: number, extra: Partial<MemoryModule> = {}): MemoryModule => ({
  locator,
  bank,
  sizeBytes: gib * GiB,
  type: 'DDR5',
  formFactor: 'DIMM',
  manufacturer: 'MemCo',
  partNumber: 'PN-1',
  ratedMts: 5600,
  configuredMts: 5600,
  empty: gib === 0,
  ...extra,
});

const dev = (address: string, device: string, link = linkInfo(16, 16, 32, 32), slot = ''): PciDevice => ({ address, className: 'VGA', vendor: 'GpuCo', device, driver: 'drv', slot, link });
const slot = (designation: string, kind: Slot['kind'], lanes: number | undefined, devices: PciDevice[] = [], usage: Slot['usage'] = devices.length ? 'in_use' : 'available'): Slot => ({ designation, kind, slotType: '', busAddress: '', usage, length: '', lanes, generation: 5, devices });
const nvme = (device: string, address: string, model: string, gb: number): NvmeDrive => ({ device, address, model, firmware: 'FW1', capacityBytes: gb * 1e9, link: linkInfo(4, 4, 16, 16) });
const gpu = (address: string, kind: Gpu['kind'], model: string, extra: Partial<Gpu> = {}): Gpu => ({ address, kind, vendor: 'GpuCo', model, driver: '', ...extra });

const base = (): HardwareProfile => ({
  node: 'worker-1',
  collectorUp: true,
  board: { vendor: 'Acme', model: 'Board X', version: '', biosVendor: '', biosVersion: '', biosDate: '' },
  cpu: { socketsTotal: 1, socketsPopulated: 1, sockets: [{ socket: 'CPU1', model: 'Fake CPU 9000', populated: true, cores: 16, threads: 32 }] },
  memory: { installedFromModules: true, modules: [] },
  slots: [],
  pciDevices: [],
  gpus: [],
  nvme: [],
});

function desktop(): HardwareProfile {
  const gpuDev = dev('0000:01:00.0', 'Fake GPU 1', linkInfo(8, 16, 32, 32), 'PCIEX16_1');
  const m2Dev = dev('0000:03:00.0', 'Fake SSD', linkInfo(4, 4, 16, 16), 'M2_1');
  return {
    ...base(),
    memory: {
      installedFromModules: true,
      installedBytes: 32 * GiB,
      maxBytes: 128 * GiB,
      slotsTotal: 4,
      slotsUsed: 2,
      modules: [mod('DIMM_A1', 'BANK 0', 16), mod('DIMM_A2', 'BANK 0', 0), mod('DIMM_B1', 'BANK 1', 16), mod('DIMM_B2', 'BANK 1', 0)],
    },
    slots: [slot('PCIEX16_1', 'pcie', 16, [gpuDev]), slot('PCIEX4_1', 'pcie', 4), slot('M2_1', 'm2', undefined, [m2Dev])],
    pciDevices: [gpuDev, m2Dev],
    gpus: [gpu('0000:01:00.0', 'discrete', 'Fake GPU 1', { vramBytes: 16 * GiB, link: gpuDev.link }), gpu('0000:00:02.0', 'integrated', 'Fake iGPU')],
    nvme: [nvme('nvme0', '0000:03:00.0', 'Fake SSD', 2000), nvme('nvme1', '0000:04:00.0', 'Fake SSD 2', 1000), nvme('nvme2', '0000:05:00.0', 'Fake SSD 3', 500)],
  };
}

function server(): HardwareProfile {
  const modules: MemoryModule[] = [];
  for (let bank = 0; bank < 8; bank++) {
    for (const k of ['A', 'B']) {
      modules.push(mod(`DIMM_${k}${bank}`, `P0_CH${bank}`, bank < 4 && k === 'A' ? 32 : 0));
    }
  }
  return {
    ...base(),
    node: 'server-1',
    cpu: { socketsTotal: 2, socketsPopulated: 2, sockets: [{ socket: 'CPU0', model: 'Fake Xeon 1', populated: true, cores: 24, threads: 48 }, { socket: 'CPU1', model: 'Fake Xeon 1', populated: true, cores: 24, threads: 48 }] },
    memory: { installedFromModules: true, installedBytes: 128 * GiB, maxBytes: 1024 * GiB, modules },
    pciDevices: [dev('0000:3b:00.0', 'Fake NIC', linkInfo(8, 8, 16, 16)), dev('0000:41:00.0', 'Fake HBA', linkInfo(4, 8, 8, 8))],
    gpus: [gpu('0000:02:00.0', 'bmc', 'Fake BMC VGA')],
  };
}

function minimal(): HardwareProfile {
  return { node: 'worker-1', cpu: { sockets: [] }, memory: { installedFromModules: false, modules: [] }, slots: [], pciDevices: [], gpus: [], nvme: [], board: { vendor: 'Acme', model: 'Board X', version: '', biosVendor: '', biosVersion: '', biosDate: '' } };
}

const rectsOverlap = (a: BoardShape, b: BoardShape) => a.x < b.x + b.w - 0.01 && b.x < a.x + a.w - 0.01 && a.y < b.y + b.h - 0.01 && b.y < a.y + a.h - 0.01;
const contains = (a: BoardShape, b: BoardShape) => a.x <= b.x + 0.01 && a.y <= b.y + 0.01 && a.x + a.w >= b.x + b.w - 0.01 && a.y + a.h >= b.y + b.h - 0.01;

/** Two shapes may overlap only when a container holds the other one completely. */
function overlaps(layout: BoardLayout): string[] {
  const bad: string[] = [];
  const s = layout.shapes;
  for (let i = 0; i < s.length; i++) {
    for (let j = i + 1; j < s.length; j++) {
      if (!rectsOverlap(s[i], s[j])) {
        continue;
      }
      const ok = (s[i].container && contains(s[i], s[j])) || (s[j].container && contains(s[j], s[i]));
      if (!ok) {
        bad.push(`${s[i].id} x ${s[j].id}`);
      }
    }
  }
  return bad;
}

const ids = (l: BoardLayout) => l.shapes.map(s => s.id);
const shape = (l: BoardLayout, id: string) => l.shapes.find(s => s.id === id)!;
const texts = (l: BoardLayout) => l.shapes.flatMap(s => s.labels.map(t => t.text));
const fixtures: [string, () => HardwareProfile][] = [['desktop', desktop], ['server', server], ['minimal', minimal]];

describe('layoutBoard', () => {
  it('is deterministic and stays inside the canvas', () => {
    for (const [, make] of fixtures) {
      for (const width of [480, 720, 960, 1400]) {
        const a = layoutBoard(make(), width);
        expect(layoutBoard(make(), width)).toEqual(a);
        expect(overlaps(a)).toEqual([]);
        for (const s of a.shapes) {
          expect(s.x).toBeGreaterThanOrEqual(0);
          expect(s.y).toBeGreaterThanOrEqual(0);
          expect(s.x + s.w).toBeLessThanOrEqual(a.width + 0.01);
          expect(s.y + s.h).toBeLessThanOrEqual(a.height + 0.01);
          expect(s.title).not.toBe('');
        }
      }
    }
  });

  it('draws a desktop with DIMMs, slots, M.2 sockets, GPU and iGPU', () => {
    const l = layoutBoard(desktop(), 960);
    expect(texts(l)).toContain('Acme Board X');
    const dimms = l.shapes.filter(s => s.id.startsWith('dimm-'));
    expect(dimms.map(s => s.state)).toEqual(['filled', 'empty', 'filled', 'empty']);
    expect(texts(l)).toContain('16G');
    expect(texts(l)).toContain('32 GiB of 128 GiB');
    expect(shape(l, 'memory-capacity-used').w).toBeCloseTo(shape(l, 'memory-capacity').w / 4, 1);
    // the x16 bar is four times the x4 bar
    expect(shape(l, 'slot-PCIEX16_1').w).toBeCloseTo(4 * shape(l, 'slot-PCIEX4_1').w, 1);
    expect(shape(l, 'slot-PCIEX4_1').state).toBe('empty');
    expect(texts(l).some(t => t.includes('Fake GPU 1') && t.includes('Gen5 x8 (max x16)'))).toBe(true);
    // 1 listed M.2 plus 3 drives gives max(1, 3) sockets
    expect(ids(l).filter(i => i.startsWith('m2-'))).toHaveLength(3);
    expect(texts(l).filter(t => t === 'M.2 (not listed by firmware)')).toHaveLength(2);
    expect(texts(l).some(t => t.includes('Fake SSD 2'))).toBe(true);
    expect(ids(l)).toContain('igpu-0');
    expect(texts(l)).toContain('iGPU');
    expect(ids(l)).not.toContain('chip-0');
  });

  it('uses free listed M.2 sockets for unmatched drives', () => {
    const p = desktop();
    p.slots.push(slot('M2_2', 'm2', undefined), slot('M2_3', 'm2', undefined), slot('M2_4', 'm2', undefined));
    p.nvme = p.nvme.slice(0, 2);
    const l = layoutBoard(p, 960);
    expect(ids(l).filter(i => i.startsWith('m2-'))).toHaveLength(4);
    expect(texts(l).some(t => t.includes('Fake SSD 2'))).toBe(true);
    expect(texts(l)).not.toContain('M.2 (not listed by firmware)');
  });

  it('draws a server with 16 DIMM slots in 8 banks, a BMC chip and no slot data', () => {
    const l = layoutBoard(server(), 960);
    expect(l.shapes.filter(s => s.id.startsWith('dimm-'))).toHaveLength(16);
    expect(l.shapes.filter(s => s.id.startsWith('cpu-'))).toHaveLength(2);
    expect(l.shapes.find(s => s.id === 'memory')!.labels.filter(t => t.text.startsWith('P0_CH'))).toHaveLength(8);
    expect(texts(l)).toContain('BMC');
    expect(texts(l)).toContain('Devices (slot unknown)');
    expect(ids(l).filter(i => i.startsWith('slot-'))).toHaveLength(0);
    expect(texts(l).some(t => t.includes('Fake HBA') && t.includes('(max x8)'))).toBe(true);
    expect(l.shapes.filter(s => s.id.startsWith('device-')).map(s => s.state)).toEqual(['filled', 'warn']);
  });

  it('draws a placeholder for a node with only board data', () => {
    const l = layoutBoard(minimal(), 960);
    expect(texts(l)).toContain('Acme Board X');
    expect(texts(l).some(t => t.includes('collector not reporting'))).toBe(true);
    expect(ids(l)).toEqual(['board', 'placeholder']);
  });

  it('marks a link below its maximum width with the warning state', () => {
    const l = layoutBoard(desktop(), 960);
    expect(shape(l, 'slot-PCIEX16_1').state).toBe('warn');
    expect(shape(l, 'slot-PCIEX16_1').title).toContain('below its maximum width');
    const ok = desktop();
    ok.slots[0].devices[0].link = linkInfo(16, 16, 32, 32);
    ok.gpus[0].link = ok.slots[0].devices[0].link;
    expect(shape(layoutBoard(ok, 960), 'slot-PCIEX16_1').state).toBe('filled');
    expect(linkText(linkInfo(2, 4, 16, 16))).toBe('Gen4 x2 (max x4)');
  });

  it('draws unknown lanes as a dashed x16 bar and unmatched discrete GPUs as chips', () => {
    const p = desktop();
    p.slots[1].lanes = undefined;
    p.gpus.push(gpu('0000:0a:00.0', 'discrete', 'Fake GPU 2'));
    const l = layoutBoard(p, 960);
    expect(shape(l, 'slot-PCIEX4_1').dashed).toBe(true);
    expect(shape(l, 'slot-PCIEX4_1').w).toBeCloseTo(shape(l, 'slot-PCIEX16_1').w, 1);
    expect(texts(l)).toContain('GPU Fake GPU 2');
    expect(overlaps(l)).toEqual([]);
  });

  it('writes SVG previews when BOARD_PREVIEW_DIR is set', () => {
    const dir = process.env.BOARD_PREVIEW_DIR;
    if (!dir) {
      return;
    }
    mkdirSync(dir, { recursive: true });
    for (const [name, make] of fixtures) {
      for (const [mode, palette] of [['light', LIGHT], ['dark', DARK]] as const) {
        writeFileSync(`${dir}/${name}-${mode}.svg`, layoutToSvg(layoutBoard(make(), 960), palette));
      }
      writeFileSync(`${dir}/${name}-narrow-light.svg`, layoutToSvg(layoutBoard(make(), 520), LIGHT));
    }
  });
});

describe('hardware tab query parameter', () => {
  it('reads known tabs', () => {
    for (const t of HW_TABS) {
      expect(parseHwTab(`?hw=${t.id}`)).toBe(t.id);
    }
    expect(parseHwTab('?a=1&hw=memory')).toBe('memory');
  });

  it('falls back to Overview for a missing or unknown value', () => {
    expect(parseHwTab('')).toBe('overview');
    expect(parseHwTab('?hw=')).toBe('overview');
    expect(parseHwTab('?hw=nope')).toBe('overview');
    expect(parseHwTab('?hw=MEMORY')).toBe('overview');
  });

  it('writes the tab and keeps other parameters', () => {
    expect(withHwTab('', 'memory')).toBe('?hw=memory');
    expect(withHwTab('?a=1', 'gpus')).toBe('?a=1&hw=gpus');
    expect(withHwTab('?a=1&hw=gpus', 'overview')).toBe('?a=1');
    expect(withHwTab('?hw=gpus', 'overview')).toBe('');
    expect(parseHwTab(withHwTab('?x=y', 'storage'))).toBe('storage');
  });
});
