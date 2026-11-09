/* Number formatting for the usage dashboard. Pure functions. */

const BYTE_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];

/** Humanises a byte count with binary units, e.g. 1536 -> "1.5 KiB". */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) {
    return '-';
  }
  const sign = bytes < 0 ? '-' : '';
  let v = Math.abs(bytes);
  let i = 0;
  while (v >= 1024 && i < BYTE_UNITS.length - 1) {
    v /= 1024;
    i++;
  }
  const digits = i === 0 || v >= 100 ? 0 : v >= 10 ? 1 : 2;
  return `${sign}${v.toFixed(digits)} ${BYTE_UNITS[i]}`;
}

/** Bytes per second, e.g. "12 KiB/s". */
export function formatRate(bytesPerSecond: number): string {
  return Number.isFinite(bytesPerSecond) ? `${formatBytes(bytesPerSecond)}/s` : '-';
}

/** Average CPU cores, e.g. 0.5 -> "0.50 cores"; tiny values read "<0.01 cores". */
export function formatCores(cores: number): string {
  if (!Number.isFinite(cores)) {
    return '-';
  }
  if (cores > 0 && cores < 0.01) {
    return '<0.01 cores';
  }
  return `${cores.toFixed(cores >= 100 ? 0 : 2)} cores`;
}

/** CPU seconds expressed as core-hours, e.g. 7200 -> "2.0 core-h". */
export function formatCoreHours(coreSeconds: number): string {
  if (!Number.isFinite(coreSeconds)) {
    return '-';
  }
  const h = coreSeconds / 3600;
  if (h > 0 && h < 0.01) {
    return '<0.01 core-h';
  }
  return `${h.toFixed(h >= 100 ? 0 : h >= 10 ? 1 : 2)} core-h`;
}

/** Share of a total as a percentage string; "0%" when the total is zero. */
export function formatPercent(value: number, total: number): string {
  if (!(total > 0) || !Number.isFinite(value)) {
    return '0%';
  }
  const p = (100 * value) / total;
  if (p > 0 && p < 0.1) {
    return '<0.1%';
  }
  return `${p.toFixed(p >= 10 ? 0 : 1)}%`;
}
