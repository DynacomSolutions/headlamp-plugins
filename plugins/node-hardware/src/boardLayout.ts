/*
 * Schematic board diagram, generated from a HardwareProfile. Pure code: no React, no DOM, no
 * randomness. The same profile and width always give the same shapes in the same order.
 * The layout is logical, not physical: CPU, memory, expansion slots, M.2 sockets and other chips.
 * Colours are semantic states; the renderer maps them to the UI theme.
 */
import { formatBytes, formatGhz, Gpu, HardwareProfile, isBelowMax, LinkInfo, MemoryModule, NvmeDrive, PciDevice, pcieGeneration, Slot } from './inventory';

export type ShapeState = 'board' | 'panel' | 'filled' | 'empty' | 'warn' | 'chip' | 'placeholder';
export type Tone = 'primary' | 'muted';

export interface TextLabel {
  x: number;
  y: number;
  text: string;
  anchor?: 'start' | 'middle' | 'end';
  size?: number;
  weight?: 'normal' | 'bold';
  tone?: Tone;
}

export interface BoardShape {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  state: ShapeState;
  dashed?: boolean;
  /** Containers (board, panels, capacity track) hold other shapes, so the overlap check skips them. */
  container?: boolean;
  /** Tooltip text. */
  title: string;
  labels: TextLabel[];
}

export interface BoardLayout {
  width: number;
  height: number;
  shapes: BoardShape[];
}

const MIN_WIDTH = 480;
const PAD = 16;
const GAP = 10;
const HEAD = 30;
const WIDE_FROM = 720;
const MAX_CHIPS = 12;
const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
const natural = (a: string, b: string) => collator.compare(a, b);

/** Cuts text to fit a pixel width at a font size (rough average glyph width). */
function fit(text: string, px: number, size: number): string {
  const max = Math.max(3, Math.floor(px / (size * 0.58)));
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function dimmLabel(bytes: number): string {
  if (bytes >= 1024 * GIB) {
    return `${Math.round((bytes / (1024 * GIB)) * 10) / 10}T`;
  }
  return bytes >= GIB ? `${Math.round(bytes / GIB)}G` : `${Math.round(bytes / MIB)}M`;
}

/** "Gen5 x16", with "(max x4)" when the link runs below its maximum width. */
export function linkText(l: LinkInfo | undefined): string {
  if (!l || (l.width === undefined && l.speedGts === undefined)) {
    return '';
  }
  const gen = pcieGeneration(l.speedGts);
  const base = `${gen ? `Gen${gen} ` : ''}x${l.width ?? '?'}`;
  return l.belowMaxWidth ? `${base} (max x${l.maxWidth})` : base;
}

function slotLanes(s: Slot): number | undefined {
  if (s.lanes !== undefined && s.lanes > 0) {
    return s.lanes;
  }
  const m = /^x(\d+)\b/i.exec(s.slotType.trim());
  return m ? Number(m[1]) : undefined;
}

const deviceName = (d: PciDevice) => `${d.vendor} ${d.device}`.trim() || d.address;

class Builder {
  shapes: BoardShape[] = [];
  add(s: BoardShape): BoardShape {
    this.shapes.push(s);
    return s;
  }
  panel(id: string, heading: string, x: number, y: number, w: number): BoardShape {
    return this.add({ id, x, y, w, h: HEAD, state: 'panel', container: true, title: heading, labels: [{ x: x + 10, y: y + 20, text: heading, size: 12, weight: 'bold', tone: 'muted' }] });
  }
  /** Rows of text chips that wrap inside a width. Returns the height used. */
  chips(prefix: string, items: { text: string; title: string; state: ShapeState }[], x: number, y: number, w: number): number {
    let cx = x;
    let cy = y;
    items.forEach((it, i) => {
      const cw = Math.min(w, it.text.length * 7 + 18);
      if (cx > x && cx + cw > x + w) {
        cx = x;
        cy += 28 + 6;
      }
      this.add({ id: `${prefix}-${i}`, x: cx, y: cy, w: cw, h: 28, state: it.state, title: it.title, labels: [{ x: cx + cw / 2, y: cy + 18, text: it.text, anchor: 'middle', size: 12 }] });
      cx += cw + 6;
    });
    return items.length === 0 ? 0 : cy - y + 28;
  }
}

function cpuBlock(b: Builder, p: HardwareProfile, i: number, x: number, y: number, w: number, h: number, igpus: Gpu[]): void {
  const s = p.cpu.sockets[i];
  const id = `cpu-${i}`;
  if (!s.populated) {
    b.add({ id, x, y, w, h, state: 'empty', title: `${s.socket}: empty socket`, labels: [{ x: x + 10, y: y + 22, text: fit(s.socket, w - 20, 13), size: 13, weight: 'bold' }, { x: x + 10, y: y + 42, text: 'Empty socket', size: 12, tone: 'muted' }] });
    return;
  }
  const counts = [s.cores !== undefined ? `${s.cores} cores` : '', s.threads !== undefined ? `${s.threads} threads` : ''].filter(Boolean).join(' / ');
  const title = [`${s.socket}: ${s.model || 'unknown model'}`, counts, s.maxHz !== undefined ? `max ${formatGhz(s.maxHz)}` : ''].filter(Boolean).join(', ');
  b.add({
    id,
    x,
    y,
    w,
    h,
    state: 'filled',
    container: igpus.length > 0,
    title,
    labels: [
      { x: x + 10, y: y + 20, text: fit(s.socket, w - 20, 11), size: 11, tone: 'muted' },
      { x: x + 10, y: y + 38, text: fit(s.model || 'CPU', w - 20, 13), size: 13, weight: 'bold' },
      { x: x + 10, y: y + 56, text: fit(counts || 'cores unknown', w - 20, 12), size: 12 },
    ],
  });
  igpus.forEach((g, k) => {
    const cw = 48;
    const cx = x + w - 8 - (igpus.length - k) * (cw + 4) + 4;
    b.add({ id: `igpu-${k}`, x: cx, y: y + h - 28, w: cw, h: 20, state: 'chip', title: `Integrated GPU: ${[g.vendor, g.model].filter(Boolean).join(' ') || 'unknown'}${g.vramBytes !== undefined ? `, ${formatBytes(g.vramBytes)}` : ''}`, labels: [{ x: cx + cw / 2, y: y + h - 14, text: 'iGPU', anchor: 'middle', size: 11 }] });
  });
}

function memoryPanel(b: Builder, p: HardwareProfile, x: number, y: number, w: number, minH: number): number {
  const m = p.memory;
  const panel = b.panel('memory', 'Memory', x, y, w);
  const innerX = x + 10;
  const innerW = w - 20;
  let cy = y + HEAD + 4;
  const modules = [...m.modules].sort((a, c) => natural(a.bank, c.bank) || natural(a.locator, c.locator));
  const BAR_H = 64;
  if (modules.length === 0) {
    b.add({ id: 'memory-none', x: innerX, y: cy, w: innerW, h: 32, state: 'placeholder', dashed: true, title: 'Per-slot memory details are not reported', labels: [{ x: innerX + 10, y: cy + 20, text: 'Memory modules not reported', size: 12, tone: 'muted' }] });
    cy += 32 + GAP;
  } else {
    const groups: { bank: string; mods: MemoryModule[] }[] = [];
    for (const mod of modules) {
      const g = groups[groups.length - 1];
      if (g && g.bank === mod.bank) {
        g.mods.push(mod);
      } else {
        groups.push({ bank: mod.bank, mods: [mod] });
      }
    }
    const GROUP_GAP = 16;
    const BAR_GAP = 4;
    const gaps = (groups.length - 1) * GROUP_GAP + groups.reduce((n, g) => n + g.mods.length - 1, 0) * BAR_GAP;
    const bw = Math.max(12, Math.min(34, (innerW - gaps) / modules.length));
    let bx = innerX;
    for (const g of groups) {
      const gx = bx;
      for (const mod of g.mods) {
        const slow = !mod.empty && mod.ratedMts !== undefined && mod.configuredMts !== undefined && mod.configuredMts < mod.ratedMts;
        const state: ShapeState = mod.empty ? 'empty' : slow ? 'warn' : 'filled';
        const detail = mod.empty
          ? 'empty'
          : [formatBytes(mod.sizeBytes), `${mod.type} ${mod.formFactor}`.trim(), mod.ratedMts !== undefined ? `rated ${mod.ratedMts} MT/s` : '', mod.configuredMts !== undefined ? `running ${mod.configuredMts} MT/s` : '', mod.manufacturer, mod.partNumber]
              .filter(Boolean)
              .join(', ');
        b.add({
          id: `dimm-${mod.bank}-${mod.locator}`,
          x: bx,
          y: cy,
          w: bw,
          h: BAR_H,
          state,
          title: `${mod.bank ? `${mod.bank} / ` : ''}${mod.locator}: ${detail}`,
          labels: mod.empty ? [] : [{ x: bx + bw / 2, y: cy + BAR_H / 2 + 4, text: dimmLabel(mod.sizeBytes), anchor: 'middle', size: bw < 22 ? 8 : 10 }],
        });
        bx += bw + BAR_GAP;
      }
      const gw = bx - BAR_GAP - gx;
      if (g.bank) {
        const panelLabel = b.shapes.find(s => s.id === 'memory');
        panelLabel?.labels.push({ x: gx + gw / 2, y: cy + BAR_H + 14, text: fit(g.bank, gw + GROUP_GAP - 2, 10), anchor: 'middle', size: 10, tone: 'muted' });
      }
      bx += GROUP_GAP - BAR_GAP;
    }
    cy += BAR_H + 22;
  }
  if (m.installedBytes !== undefined) {
    const known = m.maxBytes !== undefined && m.maxBytes > 0;
    const text = known ? `${formatBytes(m.installedBytes)} of ${formatBytes(m.maxBytes)}` : `${formatBytes(m.installedBytes)} installed (maximum unknown)`;
    const source = m.installedFromModules ? '' : ' (kernel total, module sizes not reported)';
    if (known) {
      const ratio = Math.max(0, Math.min(1, m.installedBytes / (m.maxBytes as number)));
      b.add({ id: 'memory-capacity', x: innerX, y: cy, w: innerW, h: 14, state: 'empty', container: true, title: `Installed ${text}${source}`, labels: [] });
      b.add({ id: 'memory-capacity-used', x: innerX, y: cy, w: Math.max(2, innerW * ratio), h: 14, state: 'filled', title: `Installed ${text}${source}`, labels: [] });
    }
    panel.labels.push({ x: innerX, y: cy + (known ? 30 : 12), text: `${text}${source}`, size: 12 });
    cy += known ? 38 : 20;
  }
  panel.h = Math.max(minH, cy - y + 6);
  return panel.h;
}

function expansionPanel(b: Builder, p: HardwareProfile, slots: Slot[], x: number, y: number, w: number, discrete: Gpu[]): number {
  const panel = b.panel('expansion', 'Expansion slots (PCIe)', x, y, w);
  const labelW = 140;
  const barX = x + 10 + labelW;
  const barMax = Math.max(80, (w - 20 - labelW) * 0.45);
  const textX = barX + barMax + 12;
  const textW = x + w - 10 - textX;
  let cy = y + HEAD + 2;
  for (const s of slots) {
    const lanes = slotLanes(s);
    const bw = lanes === undefined ? barMax : Math.max(28, (Math.min(lanes, 16) / 16) * barMax);
    const dev = s.devices[0];
    const gpu = dev ? discrete.find(g => g.address === dev.address) : undefined;
    const link = dev?.link ?? gpu?.link;
    const warn = isBelowMax(link);
    const occupied = !!dev || s.usage === 'in_use';
    const state: ShapeState = occupied ? (warn ? 'warn' : 'filled') : 'empty';
    const name = gpu ? [gpu.model || deviceName(dev), gpu.vramBytes !== undefined ? formatBytes(gpu.vramBytes) : ''].filter(Boolean).join(' ') : dev ? deviceName(dev) : occupied ? 'In use' : 'Free';
    const lt = linkText(link);
    // Cut the name, never the link: the warning must stay readable.
    const label = lt ? `${fit(name, textW - lt.length * 12 * 0.58 - 14, 12)}  ${lt}` : fit(name, textW, 12);
    const title = [
      `${s.designation}: ${s.slotType || 'PCIe'}`,
      lanes !== undefined ? `x${lanes}` : 'lanes unknown (drawn as x16)',
      s.generation !== undefined ? `Gen${s.generation}` : '',
      dev ? `${gpu ? 'GPU' : 'device'}: ${name}` : occupied ? 'in use' : 'free',
      lt ? `link ${lt}` : '',
      warn ? 'link runs below its maximum width' : '',
    ]
      .filter(Boolean)
      .join(', ');
    b.add({
      id: `slot-${s.designation}`,
      x: barX,
      y: cy,
      w: bw,
      h: 26,
      state,
      dashed: lanes === undefined,
      title,
      labels: [
        { x: x + 10, y: cy + 17, text: fit(s.designation, labelW - 8, 12), size: 12 },
        { x: barX + bw / 2, y: cy + 17, text: lanes === undefined ? 'x?' : `x${lanes}`, anchor: 'middle', size: 11 },
        { x: textX, y: cy + 17, text: label, size: 12, tone: occupied ? 'primary' : 'muted' },
      ],
    });
    cy += 26 + 6;
  }
  panel.h = cy - y + 4;
  return panel.h;
}

interface Socket {
  name: string;
  listed: boolean;
  drive?: NvmeDrive;
  slot?: Slot;
  device?: PciDevice;
}

function m2Sockets(p: HardwareProfile): Socket[] {
  const listed = p.slots.filter(s => s.kind === 'm2').sort((a, c) => natural(a.designation, c.designation));
  const held = new Set<string>();
  const sockets: Socket[] = listed.map(slot => {
    const device = slot.devices[0];
    const drive = device ? p.nvme.find(n => n.address === device.address) : undefined;
    if (drive) {
      held.add(drive.device);
    }
    return { name: slot.designation, listed: true, slot, device, drive };
  });
  const extra = p.nvme.filter(n => !held.has(n.device)).sort((a, c) => natural(a.device, c.device));
  // Drives that no slot holds take free listed sockets first, so the count is max(listed, drives).
  for (const drive of extra) {
    const free = sockets.find(s => s.listed && !s.drive && !s.device);
    if (free) {
      free.drive = drive;
      continue;
    }
    sockets.push({ name: 'M.2 (not listed by firmware)', listed: false, drive });
  }
  return sockets;
}

function m2Panel(b: Builder, sockets: Socket[], x: number, y: number, w: number): number {
  const panel = b.panel('m2', 'M.2 and NVMe storage', x, y, w);
  const innerW = w - 20;
  const cols = Math.max(1, Math.floor((innerW + GAP) / (250 + GAP)));
  const cw = (innerW - GAP * (cols - 1)) / cols;
  sockets.forEach((s, i) => {
    const cx = x + 10 + (i % cols) * (cw + GAP);
    const cy = y + HEAD + 2 + Math.floor(i / cols) * (44 + 8);
    const link = s.drive?.link ?? s.device?.link;
    const warn = isBelowMax(link);
    const occupied = !!s.drive || !!s.device;
    const model = s.drive ? [s.drive.model || s.drive.device, s.drive.capacityBytes !== undefined ? formatBytes(s.drive.capacityBytes) : ''].filter(Boolean).join('  ') : s.device ? deviceName(s.device) : 'Free';
    const lt = linkText(link);
    b.add({
      id: `m2-${i}`,
      x: cx,
      y: cy,
      w: cw,
      h: 44,
      state: occupied ? (warn ? 'warn' : 'filled') : 'empty',
      title: [s.name, occupied ? model : 'free', lt ? `link ${lt}` : '', s.drive?.address ? `address ${s.drive.address}` : '', warn ? 'link runs below its maximum width' : ''].filter(Boolean).join(', '),
      labels: [
        { x: cx + 8, y: cy + 17, text: fit(s.name, cw - 16, 11), size: 11, tone: 'muted' },
        { x: cx + 8, y: cy + 35, text: fit(`${model}${lt ? `  ${lt}` : ''}`, cw - 16, 12), size: 12, tone: occupied ? 'primary' : 'muted' },
      ],
    });
  });
  panel.h = HEAD + 2 + Math.ceil(sockets.length / cols) * 52 + 2;
  return panel.h;
}

export function layoutBoard(profile: HardwareProfile, widthIn: number): BoardLayout {
  const width = Math.max(MIN_WIDTH, Math.round(widthIn));
  const b = new Builder();
  const title = (profile.board ? `${profile.board.vendor} ${profile.board.model}`.trim() : '') || profile.node;
  const board = b.add({ id: 'board', x: 0, y: 0, w: width, h: 0, state: 'board', container: true, title: `Board: ${title}`, labels: [{ x: PAD, y: 26, text: fit(title, width - 2 * PAD, 16), size: 16, weight: 'bold' }] });
  const inner = width - 2 * PAD;
  let y = 44;

  const sockets = m2Sockets(profile);
  const memShown = profile.memory.modules.length > 0 || profile.memory.installedBytes !== undefined;
  const pcie = profile.slots.filter(s => s.kind === 'pcie').sort((a, c) => natural(a.designation, c.designation));
  const hasData = profile.cpu.sockets.length > 0 || memShown || profile.slots.length > 0 || profile.pciDevices.length > 0 || profile.gpus.length > 0 || profile.nvme.length > 0;

  if (!hasData) {
    const text = profile.collectorUp === undefined ? 'Inventory collector not reporting. No hardware to draw yet.' : 'No hardware data reported for this node.';
    b.add({ id: 'placeholder', x: PAD, y, w: inner, h: 56, state: 'placeholder', dashed: true, title: text, labels: [{ x: width / 2, y: y + 33, text: fit(text, inner - 20, 13), anchor: 'middle', size: 13, tone: 'muted' }] });
    y += 56 + PAD;
    board.h = y;
    return { width, height: y, shapes: b.shapes };
  }

  const discrete = profile.gpus.filter(g => g.kind === 'discrete').sort((a, c) => natural(a.address, c.address));
  const igpus = profile.gpus.filter(g => g.kind === 'integrated').sort((a, c) => natural(a.address, c.address));
  const bmcs = profile.gpus.filter(g => g.kind === 'bmc').sort((a, c) => natural(a.address, c.address));
  const firstPopulated = profile.cpu.sockets.findIndex(s => s.populated);
  const drawn = new Set<string>();

  // CPU and memory
  const wide = width >= WIDE_FROM;
  const CPU_H = 84;
  const nCpu = profile.cpu.sockets.length;
  if (nCpu > 0 || memShown) {
    if (wide) {
      const cpuW = nCpu > 0 ? Math.min(280, Math.max(200, inner * 0.3)) : 0;
      const stack = nCpu * CPU_H + Math.max(0, nCpu - 1) * GAP;
      for (let i = 0; i < nCpu; i++) {
        cpuBlock(b, profile, i, PAD, y + i * (CPU_H + GAP), cpuW, CPU_H, i === firstPopulated ? igpus : []);
      }
      let h = stack;
      if (memShown) {
        const mx = PAD + (nCpu > 0 ? cpuW + GAP : 0);
        h = Math.max(stack, memoryPanel(b, profile, mx, y, width - PAD - mx, stack));
      }
      y += h + GAP;
    } else {
      const perRow = Math.max(1, Math.min(nCpu, 2));
      const cw = (inner - GAP * (perRow - 1)) / perRow;
      for (let i = 0; i < nCpu; i++) {
        cpuBlock(b, profile, i, PAD + (i % perRow) * (cw + GAP), y + Math.floor(i / perRow) * (CPU_H + GAP), cw, CPU_H, i === firstPopulated ? igpus : []);
      }
      y += Math.ceil(nCpu / perRow) * (CPU_H + GAP);
      if (memShown) {
        y += memoryPanel(b, profile, PAD, y, inner, 0) + GAP;
      }
    }
  }
  const igpuInCpu = firstPopulated >= 0;

  // Expansion
  if (profile.slots.length === 0) {
    const devs = profile.pciDevices.filter(d => !profile.nvme.some(n => n.address === d.address) && !profile.gpus.some(g => g.address === d.address && g.kind !== 'discrete'));
    if (devs.length > 0) {
      const panel = b.panel('devices', 'Devices (slot unknown)', PAD, y, inner);
      const shown = devs.slice().sort((a, c) => natural(a.address, c.address)).slice(0, MAX_CHIPS);
      const items = shown.map(d => {
        const lt = linkText(d.link);
        return { text: fit(`${deviceName(d)}${lt ? `  ${lt}` : ''}`, 260, 12), title: `${d.address}: ${deviceName(d)}${d.className ? `, ${d.className}` : ''}${lt ? `, link ${lt}` : ''}${isBelowMax(d.link) ? ', link runs below its maximum width' : ''}`, state: (isBelowMax(d.link) ? 'warn' : 'filled') as ShapeState };
      });
      if (devs.length > shown.length) {
        items.push({ text: `+${devs.length - shown.length} more`, title: `${devs.length - shown.length} more devices not drawn`, state: 'chip' });
      }
      panel.h = HEAD + b.chips('device', items, PAD + 10, y + HEAD, inner - 20) + 10;
      y += panel.h + GAP;
      devs.forEach(d => drawn.add(d.address));
    }
  } else if (pcie.length > 0) {
    y += expansionPanel(b, profile, pcie, PAD, y, inner, discrete) + GAP;
    pcie.forEach(s => s.devices.forEach(d => drawn.add(d.address)));
  }

  // M.2
  if (sockets.length > 0) {
    y += m2Panel(b, sockets, PAD, y, inner) + GAP;
  }

  // Other chips: GPUs not drawn yet, iGPU without a CPU block, BMC
  const items: { text: string; title: string; state: ShapeState }[] = [];
  for (const g of discrete.filter(g => !drawn.has(g.address))) {
    const name = [g.model || 'GPU', g.vramBytes !== undefined ? formatBytes(g.vramBytes) : ''].filter(Boolean).join(' ');
    const lt = linkText(g.link);
    items.push({ text: fit(`GPU ${name}`, 260, 12), title: `Discrete GPU ${name}, not matched to a listed slot${lt ? `, link ${lt}` : ''}`, state: isBelowMax(g.link) ? 'warn' : 'filled' });
  }
  if (!igpuInCpu) {
    igpus.forEach(g => items.push({ text: 'iGPU', title: `Integrated GPU: ${[g.vendor, g.model].filter(Boolean).join(' ') || 'unknown'}`, state: 'chip' }));
  }
  bmcs.forEach(g => items.push({ text: 'BMC', title: `BMC display chip: ${[g.vendor, g.model].filter(Boolean).join(' ') || 'unknown'}`, state: 'chip' }));
  if (items.length > 0) {
    const panel = b.panel('other', 'GPUs and other chips', PAD, y, inner);
    panel.h = HEAD + b.chips('chip', items, PAD + 10, y + HEAD, inner - 20) + 10;
    y += panel.h + GAP;
  }

  const height = y - GAP + PAD;
  board.h = height;
  return { width, height, shapes: b.shapes };
}
