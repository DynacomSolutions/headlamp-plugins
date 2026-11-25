/*
 * The colours of the agents sunburst. A pool keeps one hue. Each identity of the pool is a shade of
 * that hue, and the shades alternate between lighter and darker, so neighbours stay apart. A
 * provider has one fixed colour, the same as in the gateway usage pie. The pool "Direct Identity"
 * and the "not reported" names are grey, because they are no real pool. Every colour is a plain
 * hex value, so the text colour on an arc comes from its real brightness, on the black kiosk and
 * in the light theme.
 */
import type { SunburstNode } from '../sunburst/geometry';
import type { ArcPaint, ArcRef } from '../sunburst/NodeRing';
import { colourAt, Mode } from '../sunburst/palette';
import {
  DIRECT,
  IDENTITY_NOT_REPORTED,
  POOL_NOT_REPORTED,
  PROVIDER_NOT_REPORTED,
  providerIndex,
} from './charts';

/** The palette slots that pools take, in order. The provider colours use the first slots. */
const POOL_SLOTS = [6, 7, 3, 5, 2, 4, 1, 0];

const GREY: Record<Mode, { direct: string; missing: string }> = {
  dark: { direct: '#A7ADB5', missing: '#6E747D' },
  light: { direct: '#6B7280', missing: '#A3A9B2' },
};

/** The id that `providerIndex` knows for a provider name, so a provider keeps its gateway colour. */
const PROVIDER_IDS: Record<string, string> = {
  anthropic: 'claude',
  openai: 'codex',
  xai: 'xai',
  zai: 'zai',
  kimi: 'kimi',
  opencode: 'opencode',
  alibaba: 'ali',
};

const canon = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

type Rgb = [number, number, number];

const hex = (n: number): string =>
  Math.max(0, Math.min(255, Math.round(n)))
    .toString(16)
    .padStart(2, '0');

/** Red, green and blue of `#rrggbb` or `hsl(h, s%, l%)`. Black for any other text. */
export function toRgb(colour: string): Rgb {
  const h = /^#([0-9a-f]{6})$/i.exec(colour.trim());
  if (h) {
    const n = parseInt(h[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const m = /^hsl\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*\)$/i.exec(colour.trim());
  if (!m) return [0, 0, 0];
  const hue = Number(m[1]);
  const s = Number(m[2]) / 100;
  const l = Number(m[3]) / 100;
  const a = s * Math.min(l, 1 - l);
  const f = (k: number): number => {
    const t = (k + hue / 30) % 12;
    return 255 * (l - a * Math.max(-1, Math.min(t - 3, 9 - t, 1)));
  };
  return [f(0), f(8), f(4)];
}

/** `colour` mixed with `towards` (`#rrggbb`) by `percent`, as `#rrggbb`. */
export function mixColour(colour: string, towards: string, percent: number): string {
  const a = toRgb(colour);
  const b = toRgb(towards);
  const k = percent / 100;
  return `#${[0, 1, 2].map(i => hex(a[i] + (b[i] - a[i]) * k)).join('')}`;
}

/** The relative brightness of a colour, from 0 (black) to 1 (white). */
export function brightness(colour: string): number {
  const lin = (v: number): number => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = toRgb(colour).map(lin);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const contrast = (a: number, b: number): number =>
  (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

/** Near-black or white text, whichever has more contrast on `colour` (at least 4.5 to 1). */
export function inkOn(colour: string): string {
  const l = brightness(colour);
  return contrast(l, brightness('#111111')) >= contrast(l, 1) ? '#111111' : '#ffffff';
}

/**
 * The shade of an identity: its place in the pool picks the amount. Even places move away from the
 * background (white on the black kiosk, black on the light theme). Odd places move towards it.
 * The amounts stay under 56 %, so a shade keeps its hue and its contrast.
 */
export function identityShade(base: string, index: number, mode: Mode): string {
  const away = mode === 'dark' ? '#ffffff' : '#000000';
  const towards = mode === 'dark' ? '#000000' : '#ffffff';
  const step = Math.floor(index / 2) % 3;
  if (index % 2 === 0) return mixColour(base, away, [22, 40, 55][step]);
  return mixColour(base, towards, [24, 38, 50][step]);
}

/** The colour of a provider. A provider that the gateway pie does not know takes the next slot. */
export function providerColour(provider: string, all: ReadonlyArray<string>, mode: Mode): string {
  if (provider === PROVIDER_NOT_REPORTED) return GREY[mode].missing;
  const id = (name: string): string => PROVIDER_IDS[canon(name)] ?? canon(name);
  return colourAt(providerIndex(id(provider), all.map(id)), mode);
}

/**
 * The paint of every arc of the agents sunburst, found by the real names. A pool takes its hue by its
 * place in the sorted pool names, so a refresh never repaints a pool.
 */
export function agentPaint(
  nodes: ReadonlyArray<SunburstNode>,
  mode: Mode
): (arc: ArcRef) => ArcPaint | undefined {
  const grey = GREY[mode];
  const pools = nodes
    .map(n => n.key)
    .filter(k => k !== DIRECT && k !== POOL_NOT_REPORTED)
    .sort();
  const poolBase = (key: string): string => {
    if (key === DIRECT) return grey.direct;
    if (key === POOL_NOT_REPORTED) return grey.missing;
    const i = Math.max(0, pools.indexOf(key));
    return colourAt(i < POOL_SLOTS.length ? POOL_SLOTS[i] : i, mode);
  };
  const providers = [
    ...new Set(nodes.flatMap(n => n.categories.flatMap(c => (c.children ?? []).map(k => k.label)))),
  ];
  const identityIndex = new Map<string, number>();
  for (const n of nodes)
    n.categories.forEach((c, i) => identityIndex.set(`${n.key}\u0000${c.key}`, i));
  const providerOf = new Map<string, string>();
  for (const n of nodes)
    for (const c of n.categories)
      for (const k of c.children ?? []) providerOf.set(`${n.key}\u0000${k.key}`, k.label);
  return arc => {
    if (arc.kind === 'free') return undefined;
    const base = poolBase(arc.nodeKey);
    let fill = base;
    if (arc.kind === 'category') {
      fill =
        arc.categoryKey === IDENTITY_NOT_REPORTED
          ? mixColour(base, mode === 'dark' ? '#000000' : '#ffffff', 55)
          : identityShade(base, identityIndex.get(`${arc.nodeKey}\u0000${arc.key}`) ?? 0, mode);
    } else if (arc.kind === 'child') {
      fill = providerColour(
        providerOf.get(`${arc.nodeKey}\u0000${arc.key}`) ?? '',
        providers,
        mode
      );
    }
    return { fill, ink: inkOn(fill) };
  };
}
