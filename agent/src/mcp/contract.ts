import { ProtocolError, ResourceTemplate, type McpServer, type UriTemplate } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { IncidentError, type IncidentService } from '../incidents/service.js';
import { parseUri, scopeForUri, SCOPES, type ParsedUri, type Scope } from '../incidents/model.js';
import { EVENTS_URI, EVENT_KINDS } from '../incidents/types.js';
import type { AutomaticInvestigationsView } from '../incidents/settings.js';
import { publicEvent, RETENTION_MS, type EventLog } from '../incidents/events.js';
import type { Runtime } from '../runtime.js';
import type { Principal } from './auth.js';
import { listNodes, listVolumes, listWorkloads, viaRegistry } from './extras.js';
import type { McpMetrics } from './metrics.js';
import * as S from './schemas.js';

export const CONTRACT_VERSION = '1.0.0';
export const META_KEY = 'dev.dynacom.headlamp/event';

export interface ContractDeps {
  runtime: Runtime;
  incidents: IncidentService;
  events: EventLog;
  settings: AutomaticInvestigationsView;
  metrics: McpMetrics;
}

interface ToolSpec<In extends z.ZodType = z.ZodType> {
  name: string;
  title: string;
  description: string;
  scope: Scope;
  input: In;
  output: z.ZodType;
  write?: boolean;
  idempotent?: boolean;
  run(args: z.infer<In>, who: Principal): Promise<{ summary: string; data: Record<string, unknown> }>;
}

const empty = z.object({}).strict();
const nodeArg = z.string().max(253).optional();

function tools(d: ContractDeps): ToolSpec[] {
  const { incidents: svc, runtime } = d;
  const spec = <In extends z.ZodType>(s: ToolSpec<In>) => s as unknown as ToolSpec;
  return [
    spec({
      name: 'list_incidents',
      title: 'List incidents',
      description: 'Lists incidents, newest first. By default only active ones (open or acknowledged).',
      scope: 'incidents:read',
      input: z.object({
        state: z.enum(['open', 'acknowledged', 'resolved', 'active']).optional(),
        severity: z.array(z.enum(['critical', 'warning', 'info', 'none'])).optional(),
        labels: z.record(z.string(), z.string()).optional().describe('Every pair must match exactly.'),
        test: z.boolean().optional().describe('true: only test incidents. false: no test incidents.'),
        limit: z.number().int().min(1).max(200).optional(),
        cursor: z.string().optional(),
      }).strict(),
      output: z.object({ incidents: z.array(S.incident), nextCursor: z.string().nullable(), total: z.number().int() }),
      idempotent: true,
      async run(a) {
        const r = await svc.list({ state: a.state, severity: a.severity, labels: a.labels, test: a.test }, a.limit ?? 50, a.cursor);
        return { summary: `${r.total} incidents${r.nextCursor ? `, showing ${r.incidents.length}` : ''}.`, data: r };
      },
    }),
    spec({
      name: 'get_incident',
      title: 'Get an incident',
      description: 'One incident by id.',
      scope: 'incidents:read',
      input: z.object({ incidentId: S.incidentId }).strict(),
      output: z.object({ incident: S.incident }),
      idempotent: true,
      async run(a) {
        const incident = await svc.get(a.incidentId);
        return { summary: `${incident.name} is ${incident.state}.`, data: { incident } };
      },
    }),
    spec({
      name: 'get_incident_timeline',
      title: 'Get the timeline of an incident',
      description: 'The timeline entries of an incident in order: firing, investigation steps, notes, acknowledgement, escalation, resolution.',
      scope: 'incidents:read',
      input: z.object({ incidentId: S.incidentId, afterSeq: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(500).optional() }).strict(),
      output: z.object({ incidentId: z.string(), entries: z.array(S.timelineEntry), nextAfterSeq: z.number().int().nullable() }),
      idempotent: true,
      async run(a) {
        const r = await svc.timeline(a.incidentId, a.afterSeq ?? 0, a.limit ?? 200);
        return { summary: `${r.entries.length} timeline entries.`, data: r };
      },
    }),
    spec({
      name: 'acknowledge_incident',
      title: 'Acknowledge an incident',
      description: 'Marks an incident as acknowledged. Does nothing for an acknowledged or resolved incident.',
      scope: 'incidents:write',
      input: z.object({ incidentId: S.incidentId, note: z.string().max(2000).optional(), requestId: S.requestId }).strict(),
      output: z.object({ incident: S.incident, changed: z.boolean(), replayed: z.boolean() }),
      write: true,
      idempotent: true,
      async run(a, who) {
        const r = await svc.acknowledge(a.incidentId, who.client, { note: a.note, requestId: a.requestId });
        return { summary: r.changed ? 'Acknowledged.' : 'No change.', data: { incident: r.value, changed: r.changed, replayed: r.replayed } };
      },
    }),
    spec({
      name: 'add_incident_note',
      title: 'Add a note to an incident',
      description: 'Adds a note to the timeline. Allowed on resolved incidents. Use requestId to make a retry safe.',
      scope: 'incidents:write',
      input: z.object({ incidentId: S.incidentId, text: z.string().min(1).max(4000), requestId: S.requestId }).strict(),
      output: z.object({ entry: S.timelineEntry, incident: S.incident, replayed: z.boolean() }),
      write: true,
      async run(a, who) {
        const r = await svc.addNote(a.incidentId, who.client, { text: a.text, requestId: a.requestId });
        return { summary: 'Note added.', data: r };
      },
    }),
    spec({
      name: 'resolve_incident',
      title: 'Resolve an incident',
      description: 'Resolves an incident by hand. If the alert fires again with a new start time, a new incident opens.',
      scope: 'incidents:resolve',
      input: z.object({ incidentId: S.incidentId, resolution: z.string().max(2000).optional(), requestId: S.requestId }).strict(),
      output: z.object({ incident: S.incident, changed: z.boolean(), replayed: z.boolean() }),
      write: true,
      idempotent: true,
      async run(a, who) {
        const r = await svc.resolve(a.incidentId, who.client, { resolution: a.resolution, requestId: a.requestId });
        return { summary: r.changed ? 'Resolved.' : 'No change.', data: { incident: r.value, changed: r.changed, replayed: r.replayed } };
      },
    }),
    spec({
      name: 'escalate_incident',
      title: 'Escalate an incident',
      description: 'Marks an incident as escalated and sends an urgent push notification. Not idempotent: use requestId for safe retries.',
      scope: 'incidents:resolve',
      input: z.object({ incidentId: S.incidentId, reason: z.string().min(1).max(2000), requestId: S.requestId }).strict(),
      output: z.object({ incident: S.incident, replayed: z.boolean() }),
      write: true,
      async run(a, who) {
        const r = await svc.escalate(a.incidentId, who.client, { reason: a.reason, requestId: a.requestId });
        return { summary: 'Escalated.', data: r };
      },
    }),
    spec({
      name: 'start_investigation',
      title: 'Start an investigation',
      description: 'Starts the incident agent on an incident. Works also when automatic investigations are off. Returns the current run when one is queued or running.',
      scope: 'agent:investigate',
      input: z.object({ incidentId: S.incidentId, model: z.string().max(200).optional(), force: z.boolean().optional(), requestId: S.requestId }).strict(),
      output: z.object({ investigation: S.investigation, started: z.boolean(), replayed: z.boolean() }),
      write: true,
      idempotent: true,
      async run(a, who) {
        const r = await svc.startInvestigation(a.incidentId, who.client, { model: a.model, force: a.force, requestId: a.requestId });
        return { summary: r.started ? 'Investigation started.' : `No new run. The current run is ${r.investigation.status}.`, data: r };
      },
    }),
    spec({
      name: 'get_investigation_status',
      title: 'Get the status of an investigation',
      description: 'The status of the investigation of an incident. Status none means no run exists.',
      scope: 'agent:investigate',
      input: z.object({ incidentId: S.incidentId }).strict(),
      output: z.object({ investigation: S.investigation }),
      idempotent: true,
      async run(a) {
        const { investigation } = await svc.investigation(a.incidentId);
        return { summary: `Investigation ${investigation.status}.`, data: { investigation } };
      },
    }),
    spec({
      name: 'get_investigation_result',
      title: 'Get the result of an investigation',
      description: 'The result of a finished investigation: cause, signals, fixes and evidence. Fails with not_ready while the run is queued or running.',
      scope: 'agent:investigate',
      input: z.object({ incidentId: S.incidentId }).strict(),
      output: z.object({ investigation: S.investigation, result: S.investigationResult.nullable() }),
      idempotent: true,
      async run(a) {
        const r = await svc.investigation(a.incidentId);
        if (r.investigation.status === 'none') throw new IncidentError('not_found', 'This incident has no investigation.');
        if (r.investigation.status === 'queued' || r.investigation.status === 'running') throw new IncidentError('not_ready', 'The investigation has not finished.');
        return { summary: r.result?.summary ?? `Investigation ${r.investigation.status}.`, data: r };
      },
    }),
    spec({
      name: 'list_storage_volumes',
      title: 'List storage volumes',
      description: 'Persistent volumes with claim, class, capacity, phase and node.',
      scope: 'storage:read',
      input: z.object({ namespace: z.string().max(253).optional(), node: nodeArg }).strict(),
      output: z.object({ volumes: z.array(z.looseObject({ name: z.string(), claim: z.string().nullable(), storageClass: z.string().nullable(), capacityBytes: z.number(), phase: z.string(), node: z.string().nullable() })) }),
      idempotent: true,
      async run(a) {
        const data = await listVolumes(runtime, a);
        return { summary: `${data.volumes.length} volumes.`, data };
      },
    }),
    spec({
      name: 'list_storage_disks',
      title: 'List disks',
      description: 'Disks per node with SMART state, temperature and problems.',
      scope: 'storage:read',
      input: z.object({ node: nodeArg }).strict(),
      output: z.object({ disks: z.array(z.looseObject({ node: z.string(), device: z.string(), model: z.string(), smartPassed: z.boolean().nullable(), temperatureC: z.number().nullable(), problems: z.array(z.string()) })) }),
      idempotent: true,
      async run(a) {
        const data = await viaRegistry(runtime, 'disk_health_smart', a.node ? { node: a.node } : {});
        return { summary: `${data.disks.length} disks.`, data: { disks: data.disks } };
      },
    }),
    spec({
      name: 'get_storage_smart',
      title: 'Get SMART health',
      description: 'The result of the disk_health_smart tool: SMART health per disk with attributes and problems.',
      scope: 'storage:read',
      input: z.object({ node: nodeArg, device: z.string().max(253).optional() }).strict(),
      output: z.object({ disks: z.array(z.looseObject({ node: z.string(), device: z.string(), model: z.string(), smartPassed: z.boolean().nullable(), temperatureC: z.number().nullable(), mediaErrors: z.number().nullable(), percentageUsed: z.number().nullable(), attributes: z.record(z.string(), z.number()), problems: z.array(z.string()) })) }),
      idempotent: true,
      async run(a) {
        const data = await viaRegistry(runtime, 'disk_health_smart', a.node ? { node: a.node } : {});
        const disks = a.device ? data.disks.filter((x: { device: string }) => x.device === a.device) : data.disks;
        return { summary: `${disks.length} disks.`, data: { disks } };
      },
    }),
    spec({
      name: 'get_storage_capacity',
      title: 'Get filesystem capacity',
      description: 'The result of the disk_health_capacity tool: free space and inodes per node filesystem, fullest first.',
      scope: 'storage:read',
      input: z.object({ node: nodeArg, minUsedPercent: z.number().min(0).max(100).optional() }).strict(),
      output: z.object({ filesystems: z.array(z.looseObject({ node: z.string(), mountpoint: z.string(), device: z.string(), usedPercent: z.number(), availGiB: z.number(), growthGiB6h: z.number().nullable(), inodesUsedPercent: z.number().nullable() })) }),
      idempotent: true,
      async run(a) {
        const data = await viaRegistry(runtime, 'disk_health_capacity', { ...(a.node ? { node: a.node } : {}), ...(a.minUsedPercent !== undefined ? { minUsedPercent: a.minUsedPercent } : {}) });
        return { summary: `${data.filesystems.length} filesystems.`, data };
      },
    }),
    spec({
      name: 'list_nodes',
      title: 'List nodes',
      description: 'Cluster nodes with readiness, roles, kubelet version and allocatable resources.',
      scope: 'registry:read',
      input: empty,
      output: z.object({ nodes: z.array(z.looseObject({ name: z.string(), ready: z.boolean(), roles: z.array(z.string()), kubeletVersion: z.string(), cpuAllocatable: z.string(), memoryAllocatable: z.string(), conditions: z.array(z.object({ type: z.string(), status: z.string() })) })) }),
      idempotent: true,
      async run() {
        const data = await listNodes(runtime);
        return { summary: `${data.nodes.length} nodes, ${data.nodes.filter(n => !n.ready).length} not ready.`, data };
      },
    }),
    spec({
      name: 'list_workloads',
      title: 'List workloads',
      description: 'Deployments, StatefulSets and DaemonSets with desired, ready and available counts.',
      scope: 'registry:read',
      input: z.object({ namespace: z.string().max(253).optional(), kind: z.enum(['Deployment', 'StatefulSet', 'DaemonSet']).optional(), unhealthyOnly: z.boolean().optional() }).strict(),
      output: z.object({ workloads: z.array(z.looseObject({ kind: z.string(), namespace: z.string(), name: z.string(), desired: z.number(), ready: z.number(), available: z.number() })) }),
      idempotent: true,
      async run(a) {
        const data = await listWorkloads(runtime, a);
        return { summary: `${data.workloads.length} workloads.`, data };
      },
    }),
    spec({
      name: 'get_automatic_investigations',
      title: 'Get the automatic investigations setting',
      description: 'Whether the agent starts investigations on its own. When off, incidents still open and stream.',
      scope: 'settings:read',
      input: empty,
      output: z.object({ enabled: z.boolean(), changedAt: z.string().nullable(), changedBy: z.string().nullable() }),
      idempotent: true,
      async run() {
        const s = await d.settings.get();
        return { summary: `Automatic investigations are ${s.enabled ? 'on' : 'off'}.`, data: { ...s } };
      },
    }),
  ];
}

/** The tool names of this contract, for metrics and tests. */
export const CONTRACT_TOOLS = ['list_incidents', 'get_incident', 'get_incident_timeline', 'acknowledge_incident', 'add_incident_note', 'resolve_incident', 'escalate_incident', 'start_investigation', 'get_investigation_status', 'get_investigation_result', 'list_storage_volumes', 'list_storage_disks', 'get_storage_smart', 'get_storage_capacity', 'list_nodes', 'list_workloads', 'get_automatic_investigations'];

const json = (uri: URL, value: unknown) => ({ contents: [{ uri: uri.toString(), mimeType: 'application/json', text: JSON.stringify(value) }] });

/** Reads one `headlamp://` resource. Throws IncidentError. */
export async function readContractResource(d: ContractDeps, parsed: ParsedUri, who: Principal): Promise<unknown> {
  const call = async (name: string, args: Record<string, unknown>) => (await tools(d).find(t => t.name === name)!.run(args, who)).data;
  switch (parsed.type) {
    case 'incidents':
      return d.incidents.list(parsed.filter, 200);
    case 'incident':
      return { incident: await d.incidents.get(parsed.id) };
    case 'timeline':
      return d.incidents.timeline(parsed.id, 0, 500);
    case 'investigation':
      return d.incidents.investigation(parsed.id);
    case 'settings':
      return d.settings.get();
    case 'storage': {
      const node = parsed.node ? { node: parsed.node } : {};
      if (parsed.kind === 'volumes') return call('list_storage_volumes', node);
      if (parsed.kind === 'disks') return call('list_storage_disks', node);
      if (parsed.kind === 'smart') return call('get_storage_smart', node);
      return call('get_storage_capacity', node);
    }
    case 'contract':
      return { contract: CONTRACT_VERSION, scopes: SCOPES, eventKinds: EVENT_KINDS, retentionHours: RETENTION_MS / 3600_000 };
    case 'events': {
      if (parsed.after === undefined) {
        const head = await d.events.head();
        return { events: [], nextAfter: head.latest ?? '0', hasMore: false, latest: head.latest, oldestRetained: head.oldestRetained, reset: false };
      }
      const page = await d.events.readAfter(BigInt(parsed.after), parsed.limit ?? 100, { kinds: parsed.kinds, labels: parsed.labels });
      return { ...page, events: page.events.map(publicEvent) };
    }
  }
}

/** A URI template that the SDK can match: it accepts any URI that `parseUri` reads as one of `types`. */
function template(text: string, types: ParsedUri['type'][]): UriTemplate {
  return { match: (uri: string) => ((p => (p && types.includes(p.type) ? {} : null))(parseUri(uri))), toString: () => text } as unknown as UriTemplate;
}

const FIXED: Array<{ name: string; uri: string; title: string; description: string }> = [
  { name: 'incidents', uri: 'headlamp://incidents', title: 'Active incidents', description: 'Open and acknowledged incidents, newest first.' },
  { name: 'event-log', uri: EVENTS_URI, title: 'Event log head', description: 'The newest and oldest retained event ids. Subscribe to receive every event.' },
  { name: 'automatic-investigations', uri: 'headlamp://settings/automatic-investigations', title: 'Automatic investigations', description: 'Whether the agent investigates on its own.' },
  { name: 'storage-volumes', uri: 'headlamp://storage/volumes', title: 'Storage volumes', description: 'Persistent volumes.' },
  { name: 'storage-disks', uri: 'headlamp://storage/disks', title: 'Disks', description: 'Disks with SMART state.' },
  { name: 'storage-smart', uri: 'headlamp://storage/smart', title: 'SMART health', description: 'SMART health per disk.' },
  { name: 'storage-capacity', uri: 'headlamp://storage/capacity', title: 'Filesystem capacity', description: 'Free space per filesystem.' },
  { name: 'contract', uri: 'headlamp://contract', title: 'Contract', description: 'Contract version, scopes and event kinds.' },
];

const TEMPLATES: Array<{ name: string; text: string; types: ParsedUri['type'][]; title: string }> = [
  { name: 'incident', text: 'headlamp://incidents/{id}', types: ['incident'], title: 'Incident' },
  { name: 'incident-timeline', text: 'headlamp://incidents/{id}/timeline', types: ['timeline'], title: 'Incident timeline' },
  { name: 'investigation', text: 'headlamp://investigations/{id}', types: ['investigation'], title: 'Investigation' },
  { name: 'incidents-filtered', text: 'headlamp://incidents{?state,severity,label,test}', types: ['incidents'], title: 'Incidents with a filter' },
  { name: 'event-log-catch-up', text: 'headlamp://events{?after,limit,kind,label}', types: ['events'], title: 'Event log catch-up' },
  { name: 'storage-by-node', text: 'headlamp://storage/{kind}/{node}', types: ['storage'], title: 'Storage of one node' },
];

/** Registers the tools and resources of the contract that the caller may use. Others are registered and disabled, so they do not show in lists. */
export function registerContract(server: McpServer, d: ContractDeps, who: Principal): void {
  for (const t of tools(d)) {
    const registered = server.registerTool(
      t.name,
      {
        title: t.title,
        description: t.description,
        inputSchema: t.input,
        outputSchema: t.output,
        annotations: { readOnlyHint: !t.write, destructiveHint: false, idempotentHint: t.idempotent ?? false, openWorldHint: false },
        _meta: { 'dev.dynacom.headlamp/scope': t.scope },
      },
      async (args: unknown) => {
        d.metrics.toolCall(t.name, who.client);
        try {
          const r = await t.run(args as never, who);
          return { content: [{ type: 'text' as const, text: r.summary }], structuredContent: r.data };
        } catch (error) {
          const e = error instanceof IncidentError ? error : new IncidentError(/unavailable|answered \d+|fetch failed|ECONN|timed out/i.test(String((error as Error)?.message)) ? 'unavailable' : 'internal', error instanceof Error ? error.message : String(error));
          d.metrics.toolError(t.name, e.code);
          return { isError: true, content: [{ type: 'text' as const, text: e.message }], structuredContent: { error: { code: e.code, message: e.message, ...e.extra } } };
        }
      },
    );
    if (!who.scopes.has(t.scope)) registered.disable();
  }

  for (const r of FIXED) {
    const parsed = parseUri(r.uri)!;
    const scope = scopeForUri(parsed);
    const registered = server.registerResource(
      r.name,
      r.uri,
      { title: r.title, description: r.description, mimeType: 'application/json' },
      async uri => json(uri, await guard(d, () => readContractResource(d, parseUri(uri.toString())!, who))),
    );
    if (scope && !who.scopes.has(scope)) registered.disable();
  }
  for (const t of TEMPLATES) {
    const scope = scopeForUri(parseUri(t.text.replace('{id}', 'x').replace('{kind}', 'volumes').replace('{node}', 'n').replace(/\{\?.*\}/, ''))!);
    const registered = server.registerResource(
      t.name,
      new ResourceTemplate(template(t.text, t.types), { list: t.name === 'incident' ? async () => ({ resources: await activeIncidentResources(d) }) : undefined }),
      { title: t.title, mimeType: 'application/json' },
      async (uri: URL) => {
        const parsed = parseUri(uri.toString());
        if (!parsed) throw new ProtocolError(-32602, `Resource URI ${uri} is invalid`);
        return json(uri, await guard(d, () => readContractResource(d, parsed, who)));
      },
    );
    if (scope && !who.scopes.has(scope)) registered.disable();
  }
}

/** Turns a contract error into a JSON-RPC error with the contract code. */
async function guard<T>(d: ContractDeps, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof IncidentError) {
      d.metrics.toolError('resources/read', error.code);
      throw new ProtocolError(error.code === 'not_found' ? -32002 : error.code === 'invalid_argument' ? -32602 : -32000, error.message, { code: error.code });
    }
    throw error;
  }
}

/** Resource listing for the first 200 active incidents: `resources/list` of a contract-aware session. */
export async function activeIncidentResources(d: ContractDeps) {
  const { incidents } = await d.incidents.list({}, 200);
  return incidents.map(i => ({ uri: i.uri, name: `${i.name} ${i.createdAt}`, mimeType: 'application/json' }));
}

