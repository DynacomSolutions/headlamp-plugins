/** Shapes shared by the local (Kubernetes-derived) model and the optional scanner endpoint. */

export interface Job {
  key: string;
  name: string;
  repository: string;
  workflow: string;
  workflow_ref: string;
  run_id?: number | string | null;
  job_id?: string | null;
  numeric_job_id?: number | null;
  url?: string | null;
  run_url?: string | null;
  runner_name: string;
  scale_set: string;
  node_id?: string | null;
  status: string;
  conclusion?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
}

export interface Starting {
  name: string;
  runner_name: string;
  scale_set: string;
  phase?: string;
  started_at?: string | null;
}

export interface NodeStatus {
  id: string;
  display_name: string;
  kind: 'kubernetes' | 'external';
  ready: boolean;
  os: string;
  best_effort?: boolean;
  description?: string;
  jobs: Job[];
  starting: Starting[];
}

export interface ScaleSetSummary {
  name: string;
  min_runners?: number | null;
  max_runners?: number | null;
  current_runners?: number | null;
  pending?: number | null;
  running?: number | null;
  phase?: string | null;
  organisation?: string | null;
}

export interface Status {
  generated_at: string;
  nodes: NodeStatus[];
  scale_sets: ScaleSetSummary[];
  summary: {
    running_jobs: number;
    pending_runners: number;
    nodes_ready: number;
    nodes_total: number;
  };
}

export interface History {
  generated_at: string;
  jobs: Job[];
}

/** Raw Kubernetes object (jsonData). */
export type Raw = Record<string, any>;

export interface ModelInput {
  nodes: Raw[];
  pods: Raw[];
  runners: Raw[];
  scaleSets: Raw[];
  externalWorkers: Raw[];
  nodeAliases?: Record<string, string>;
  now?: Date;
}

export interface PluginConfig {
  statusUrl?: string;
  historyUrl?: string;
  externalWorkerGroup?: string;
  externalWorkerVersion?: string;
  nodeAliases?: string;
}
