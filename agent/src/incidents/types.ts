/** Shapes of the MCP contract (docs/mcp-contract.md, version 1.0.0). */

export const TIMELINE_KINDS = [
  'fired',
  'refired',
  'alert_resolved',
  'investigation_queued',
  'investigation_started',
  'investigation_done',
  'investigation_failed',
  'acknowledged',
  'note',
  'escalated',
  'resolved',
] as const;
export type TimelineKind = (typeof TIMELINE_KINDS)[number];

export interface TimelineEntry {
  /** 1 for the first entry. A user action is written with 0 and gets its number when the record is stored. */
  seq: number;
  at: string;
  kind: TimelineKind;
  actor: string;
  text: string | null;
  data: Record<string, unknown> | null;
}

/** What the agent adds to a diagnosis record to make it an incident. Stored inside the record. */
export interface IncidentState {
  acknowledgedAt?: string;
  acknowledgedBy?: string;
  resolvedBy?: string;
  resolution?: string;
  escalatedAt?: string;
  noteCount?: number;
  /** True when a client or an operator started the current run. */
  manualRun?: boolean;
  timeline: TimelineEntry[];
  /** Results of write calls with a requestId, kept 24 hours. */
  requests?: Record<string, { hash: string; at: string; seq?: number }>;
}

export const EVENT_KINDS = [
  'incident.created',
  'incident.updated',
  'incident.acknowledged',
  'incident.note_added',
  'incident.escalated',
  'incident.resolved',
  'investigation.queued',
  'investigation.started',
  'investigation.done',
  'investigation.failed',
  'settings.changed',
  'storage.updated',
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export interface EventRecord {
  id: string;
  at: string;
  kind: string;
  uri: string;
  incidentId: string | null;
  labels: Record<string, string>;
  actor: string | null;
  /** The state of the incident after the event. Kept for filtered subscriptions, never sent to clients. */
  state?: 'open' | 'acknowledged' | 'resolved';
  /** The state of the incident before the event. Absent for the event that opens it. Never sent to clients. */
  stateBefore?: 'open' | 'acknowledged' | 'resolved';
  /** All labels of the incident. `labels` holds only 32 of them. Filters match these. Never sent to clients. */
  fullLabels?: Record<string, string>;
}

export interface NewEvent {
  kind: EventKind;
  uri: string;
  incidentId?: string | null;
  labels?: Record<string, string>;
  actor?: string | null;
  state?: 'open' | 'acknowledged' | 'resolved';
  stateBefore?: 'open' | 'acknowledged' | 'resolved';
  fullLabels?: Record<string, string>;
}

export type InvestigationStatus = 'none' | 'skipped' | 'queued' | 'running' | 'done' | 'failed';

export const INCIDENTS_URI = 'headlamp://incidents';
export const EVENTS_URI = 'headlamp://events';
export const SETTINGS_URI = 'headlamp://settings/automatic-investigations';
export const incidentUri = (id: string): string => `headlamp://incidents/${id}`;
export const timelineUri = (id: string): string => `headlamp://incidents/${id}/timeline`;
export const investigationUri = (id: string): string => `headlamp://investigations/${id}`;
export const storageUri = (kind: string): string => `headlamp://storage/${kind}`;
