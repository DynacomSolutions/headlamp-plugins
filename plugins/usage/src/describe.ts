/* Turns raw measure values into the display strings for each resource. */
import { Measure, ResourceDef } from './resources';
import { formatBytes, formatCoreHours, formatCores, formatRate } from './units';

/** Headline value for one resource: the figure the pie and share are based on. */
export function primaryFor(def: ResourceDef, value: number, windowSeconds: number): string {
  switch (def.id) {
    case 'cpu':
      return formatCores(value / windowSeconds);
    case 'memory':
      return `${formatBytes(value)} avg`;
    default:
      return formatBytes(value);
  }
}

/** Secondary figure: core-hours, peak memory, or the average rate. */
export function secondaryFor(def: ResourceDef, values: Record<Measure, number>, windowSeconds: number): string {
  switch (def.id) {
    case 'cpu':
      return formatCoreHours(values.cpuSeconds);
    case 'memory':
      return `${formatBytes(values.memPeak)} sum of pod peaks`;
    default:
      return `${formatRate(values[def.measure] / windowSeconds)} avg`;
  }
}
