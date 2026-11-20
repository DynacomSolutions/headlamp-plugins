/*
 * The CPU limit and throttling of an agent thread as one line for the details strip. Kept apart
 * from agents.ts so that the tree code does not import the Kubernetes API client.
 */
import type { AgentUnit } from './agents';

/** "CPU limit 16 cores, throttled 12%" for the details of a thread; undefined without a limit. */
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
    const p = u.cpuThrottledRatio * 100;
    parts.push(`throttled ${p < 0.05 ? '0' : p < 10 ? p.toFixed(1) : Math.round(p)}%`);
  }
  return parts.join(', ');
}
