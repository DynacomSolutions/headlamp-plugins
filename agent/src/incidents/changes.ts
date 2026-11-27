import type { Diagnosis } from '../agent/report.js';
import { eventLabels, incidentState, investigationStatus } from './model.js';
import { incidentUri, investigationUri, timelineUri, type EventKind, type IncidentState, type NewEvent, type TimelineEntry, type TimelineKind } from './types.js';

const MAX_TIMELINE = 500;

const USER_EVENT: Partial<Record<TimelineKind, EventKind>> = {
  acknowledged: 'incident.acknowledged',
  note: 'incident.note_added',
  escalated: 'incident.escalated',
  resolved: 'incident.resolved',
};

const STATUS_ENTRY = {
  queued: ['investigation_queued', 'investigation.queued'],
  running: ['investigation_started', 'investigation.started'],
  done: ['investigation_done', 'investigation.done'],
  failed: ['investigation_failed', 'investigation.failed'],
} as const;

/** Keeps the incident state when a writer holds an older copy of the record (the runner, the alert ingest). */
export function keepIncident(current: Diagnosis | undefined, next: Diagnosis): Diagnosis {
  if (!current?.incident) return next;
  if (!next.incident) return { ...next, incident: current.incident };
  // A writer that started from an older copy must not drop entries that were added meanwhile.
  if (next.incident.timeline.length < current.incident.timeline.length) return { ...next, incident: current.incident };
  return next;
}

/**
 * Works out what a write changed. It assigns numbers to new timeline entries, adds the entries that the agent
 * itself causes (fired, refired, resolved by alert, investigation steps) and lists the events to raise.
 * `next` is already merged with `current`. Pure: it writes nothing.
 */
export function finalise(current: Diagnosis | undefined, next: Diagnosis, now: Date): { record: Diagnosis; events: NewEvent[] } {
  const at = now.toISOString();
  const state: IncidentState = { ...(next.incident ?? { timeline: [] }), timeline: [...(next.incident?.timeline ?? [])] };
  const events: NewEvent[] = [];
  const nextState = () => incidentState({ ...next, incident: state });

  const add = (entry: Omit<TimelineEntry, 'seq'> & { seq?: number }): TimelineEntry => {
    const full = { ...entry, seq: state.timeline.length ? state.timeline[state.timeline.length - 1]!.seq + 1 : 1 };
    state.timeline.push(full);
    return full;
  };
  const raise = (kind: EventKind, uri: string, actor: string | null) => events.push({ kind, uri, incidentId: next.id, labels: eventLabels(next.alert.labels), actor, state: nextState() });

  // The entries that a person or a client wrote have seq 0. They are numbered after the firing entry.
  const pending = state.timeline.filter(e => e.seq === 0);
  state.timeline = state.timeline.filter(e => e.seq !== 0);
  // A record from before the contract has no timeline: begin it with the firing.
  if (!current || !state.timeline.length) add({ at: next.createdAt, kind: 'fired', actor: !current && next.source !== 'webhook' ? 'agent' : 'alert', text: null, data: null });
  const userEntries = pending.map(p => add({ ...p, at: p.at || at }));

  if (current && (next.fires ?? 1) > (current.fires ?? 1)) {
    add({ at: next.lastFiredAt ?? at, kind: 'refired', actor: 'alert', text: null, data: { fires: next.fires ?? 1 } });
    raise('incident.updated', incidentUri(next.id), 'alert');
  }
  if (!current) raise('incident.created', incidentUri(next.id), next.source === 'webhook' ? 'alert' : 'agent');

  const before = current ? investigationStatus(current) : 'none';
  const after = investigationStatus(next);
  if (after !== before && after !== 'none') {
    const [entryKind, eventKind] = STATUS_ENTRY[after];
    add({ at: after === 'done' || after === 'failed' ? (next.finishedAt ?? at) : at, kind: entryKind, actor: 'agent', text: after === 'failed' ? (next.error ?? null) : null, data: { model: next.model } });
    raise(eventKind, investigationUri(next.id), 'agent');
  }

  let resolvedByUser = false;
  for (const e of userEntries) {
    const kind = USER_EVENT[e.kind];
    if (!kind) continue;
    if (kind === 'incident.resolved') resolvedByUser = true;
    raise(kind, kind === 'incident.note_added' ? timelineUri(next.id) : incidentUri(next.id), e.actor);
  }
  if (next.resolvedAt && !current?.resolvedAt && !resolvedByUser) {
    const folded = Boolean(next.resolvedNote);
    add({ at: next.resolvedAt, kind: folded ? 'resolved' : 'alert_resolved', actor: folded ? 'agent' : 'alert', text: next.resolvedNote ?? null, data: null });
    raise('incident.resolved', incidentUri(next.id), folded ? 'agent' : 'alert');
  }

  if (state.timeline.length > MAX_TIMELINE) state.timeline = state.timeline.slice(-MAX_TIMELINE);
  // The incident events of one write keep their order: created, updated, investigation, user action, resolved.
  return { record: { ...next, incident: state }, events };
}
