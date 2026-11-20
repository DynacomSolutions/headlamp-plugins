/*
 * The CPU limit and throttling of an agent thread as one line for the details strip. Kept apart
 * from agents.ts so that the tree code does not import the Kubernetes API client.
 */
import type { AgentUnit } from './agents';

/** "CPU limit 16 cores, throttled 4.2 cores" for the details of a thread; undefined without a limit. */
export function cpuNote(
  u: Pick<AgentUnit, 'cpuLimitCores' | 'cpuThrottledRatio'>
): string | undefined {
  if (u.cpuLimitCores === undefined) return undefined;
  const parts = [
    u.cpuLimitCores === null
      ? 'No CPU limit'
      : `CPU limit ${Math.round(u.cpuLimitCores * 10) / 10} ${
          u.cpuLimitCores <= 1 ? 'core' : 'cores'
        }`,
  ];
  if (u.cpuThrottledRatio !== undefined) {
    // The ratio is in cores' worth of time: 4.2 is 4.2 cores of CPU time held back.
    const r = u.cpuThrottledRatio;
    parts.push(`throttled ${r === 0 ? '0' : r < 0.05 ? '<0.1' : r.toFixed(1)} cores`);
  }
  return parts.join(', ');
}
