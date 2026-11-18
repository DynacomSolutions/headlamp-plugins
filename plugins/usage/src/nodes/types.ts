export interface PodUsage {
  namespace: string;
  pod: string;
  container: string;
  cpuCores: number;
  memBytes: number;
}

/** One systemd cgroup. Values are hierarchical: a parent includes its children. */
export interface CgroupUsage {
  unit: string;
  /** The parent cgroup unit, '' for a top-level one. */
  parent: string;
  /** The agent unit name when this cgroup is an agent's, else ''. */
  agentUnit: string;
  cpuCores: number;
  /** anon + shmem + kernel; page cache is not included. */
  memBytes: number;
}

/** A group of processes of one program inside a cgroup. */
export interface ProgramUsage {
  unit: string;
  program: string;
  cpuCores: number;
  memBytes: number;
}

/** One agent unit's exported usage, from the same series and window as the cgroups. */
export interface AgentUnitUsage {
  /** The agent unit name (not the cgroup path). */
  unit: string;
  cpuCores: number;
  memBytes: number;
}

/** The host cgroup and process series of the agent-memory exporter. */
export interface SystemUsage {
  cgroups: CgroupUsage[];
  programs: ProgramUsage[];
  /** Every agent unit the exporter reports, on the same basis as `cgroups` and the node used. */
  agentUnits: AgentUnitUsage[];
  /** Kernel, page cache and other memory no cgroup holds; null when not reported. */
  remainderMem: number | null;
  remainderCpu: number | null;
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
  /** Absent when the node exports no cgroup series (old exporter, macOS). */
  system?: SystemUsage;
}
