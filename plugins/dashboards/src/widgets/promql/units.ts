/* Value formatting for the PromQL widgets. Pure functions. */

export type Unit = 'plain' | 'bytes' | 'cores' | 'percent' | 'ratio' | 'seconds';

export const UNIT_OPTIONS: ReadonlyArray<{ value: Unit; label: string }> = [
  { value: 'plain', label: 'Plain number' },
  { value: 'bytes', label: 'Bytes (KiB, MiB, GiB)' },
  { value: 'cores', label: 'CPU cores' },
  { value: 'percent', label: 'Percent (0 to 100)' },
  { value: 'ratio', label: 'Ratio shown as percent (0 to 1)' },
  { value: 'seconds', label: 'Seconds (ms, s, min, h, d)' },
];

export function isUnit(v: unknown): v is Unit {
  return UNIT_OPTIONS.some(o => o.value === v);
}

/** A number with about three significant digits, no trailing zeros: 1234 > "1234", 12.34 > "12.3". */
export function sig(v: number): string {
  if (!Number.isFinite(v)) return '-';
  if (v === 0) return '0';
  const a = Math.abs(v);
  const digits = a >= 100 ? 0 : a >= 10 ? 1 : a >= 1 ? 2 : 3;
  const fixed = a < 0.001 ? v.toExponential(1) : v.toFixed(digits);
  return fixed.includes('e') ? fixed : fixed.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}

const BYTE_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return '-';
  let v = Math.abs(bytes);
  let i = 0;
  while (v >= 1024 && i < BYTE_UNITS.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${bytes < 0 ? '-' : ''}${sig(v)} ${BYTE_UNITS[i]}`;
}

const SI = ['', 'k', 'M', 'G', 'T', 'P'];

export function formatPlain(v: number): string {
  if (!Number.isFinite(v)) return '-';
  let a = Math.abs(v);
  let i = 0;
  while (a >= 1000 && i < SI.length - 1) {
    a /= 1000;
    i += 1;
  }
  return `${v < 0 ? '-' : ''}${sig(a)}${SI[i]}`;
}

export function formatSeconds(s: number): string {
  if (!Number.isFinite(s)) return '-';
  const a = Math.abs(s);
  const sign = s < 0 ? '-' : '';
  if (a === 0) return '0 s';
  if (a < 1e-3) return `${sign}${sig(a * 1e6)} µs`;
  if (a < 1) return `${sign}${sig(a * 1e3)} ms`;
  if (a < 60) return `${sign}${sig(a)} s`;
  if (a < 3600) return `${sign}${sig(a / 60)} min`;
  if (a < 86400) return `${sign}${sig(a / 3600)} h`;
  return `${sign}${sig(a / 86400)} d`;
}

/**
 * Format a value for a unit. With `compact` the unit word is left out where an axis tick
 * would repeat it (cores).
 */
export function formatValue(
  v: number,
  unit: Unit | string | undefined,
  opts: { compact?: boolean } = {}
): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '-';
  switch (unit) {
    case 'bytes':
      return formatBytes(v);
    case 'cores':
      return opts.compact ? sig(v) : `${sig(v)} cores`;
    case 'percent':
      return `${sig(v)}%`;
    case 'ratio':
      return `${sig(v * 100)}%`;
    case 'seconds':
      return formatSeconds(v);
    default:
      return formatPlain(v);
  }
}

/** Parse an optional number from a settings text field. A blank or bad text gives undefined. */
export function parseOptionalNumber(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v !== 'string' || v.trim() === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
