export interface PodUsage {
  namespace: string;
  pod: string;
  container: string;
  cpuCores: number;
  memBytes: number;
}

export interface NodeMetrics {
  node: string;
  cpuCapacity: number;
  /** null when the node has no host metrics (no exporter). */
  cpuUsed: number | null;
  memCapacity: number;
  /** null when the node has no host metrics (no exporter). */
  memUsed: number | null;
  pods: PodUsage[];
}
