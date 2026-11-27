import { loadProviderSettings, type Config } from './config.js';
import { KubeClient } from './kube.js';
import { PromClient } from './prom.js';
import { Registry } from './registry.js';
import { allProviders } from './providers/index.js';
import { defineProvider, defineTool, z, type ProviderDefinition, type ToolContext } from './sdk.js';
import type { ToolHost } from './agent/engine.js';
import type { ToolSpec } from './agent/model.js';
import type { DiagnosisStore } from './store.js';
import type { LaunchStore } from './launch/store.js';

const MAX_BODY = 4 * 1024 * 1024;

/** GET only, to in-cluster Service DNS names only, JSON only. Panels may raise the size limit. */
export async function serviceGet(url: string, options: { maxBytes?: number } = {}): Promise<unknown> {
  const parsed = new URL(url);
  if (!/^https?:$/.test(parsed.protocol)) throw new Error('Only http and https service URLs are allowed');
  if (!/\.svc(\.cluster\.local)?$/.test(parsed.hostname)) throw new Error(`${parsed.hostname} is not an in-cluster Service name (*.svc)`);
  const res = await fetch(parsed, { method: 'GET', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000), redirect: 'error' });
  if (!res.ok) throw new Error(`${parsed.hostname} answered ${res.status}`);
  const text = await res.text();
  if (text.length > (options.maxBytes ?? MAX_BODY)) throw new Error('Service response too large');
  return JSON.parse(text);
}

function diagnosesProvider(store: DiagnosisStore): ProviderDefinition {
  const brief = z.object({ id: z.string(), alert: z.string(), severity: z.string(), status: z.string(), createdAt: z.string(), likelyCause: z.string(), confidence: z.string(), resolved: z.boolean(), resolvedAt: z.string(), labels: z.record(z.string(), z.string()) });
  return defineProvider({
    name: 'diagnoses',
    title: 'Diagnoses',
    description: 'Incident diagnoses the agent has already made (read-only)',
    tools: [
      defineTool({
        name: 'list_diagnoses',
        title: 'List past diagnoses',
        description: 'Diagnoses made so far, newest first, with the likely cause. Check here before investigating an alert that may already be diagnosed.',
        input: z.object({ alert: z.string().optional().describe('Substring of the alert name'), limit: z.number().int().min(1).max(1000).default(20) }),
        output: z.object({ diagnoses: z.array(brief) }),
        async run(args) {
          const f = args.alert?.toLowerCase();
          const { diagnoses: page } = await store.page({ alert: f, limit: args.limit });
          const diagnoses = page.map(d => ({
              id: d.id,
              alert: d.alert.name,
              severity: d.alert.severity,
              status: d.status,
              createdAt: d.createdAt,
              likelyCause: d.result?.likelyCause ?? d.error ?? '',
              confidence: d.result?.confidence ?? '',
              resolved: Boolean(d.resolvedAt),
              resolvedAt: d.resolvedAt ?? '',
              labels: d.alert.labels ?? {},
            }));
          return {
            data: { diagnoses },
            summary: `${diagnoses.length} diagnoses.`,
            view: { title: 'Diagnoses', rows: diagnoses.map(d => ({ label: d.alert, detail: d.likelyCause, status: `${d.status}${d.confidence ? ` · ${d.confidence}` : ''}` })) },
          };
        },
      }),
      defineTool({
        name: 'get_diagnosis',
        title: 'Get a diagnosis',
        description: 'One diagnosis in full: alert, likely cause, evidence, fixes and the evidence trail.',
        input: z.object({ id: z.string() }),
        output: z.object({ diagnosis: z.unknown() }),
        async run(args) {
          const d = await store.get(args.id);
          if (!d) throw new Error(`No diagnosis ${args.id}`);
          // The incident notes and the timeline need `incidents:read` through the incident tools: they are not part of this output (contract section 5.6).
          const { a2ui: _a2ui, incident: _incident, ...rest } = d;
          return {
            data: { diagnosis: rest },
            summary: `${d.alert.name}: ${d.result?.likelyCause ?? d.status}.`,
            view: { title: d.alert.name, summary: d.result?.summary ?? d.status, rows: (d.result?.fixes ?? []).map((f, i) => ({ label: `${i + 1}. ${f.title}`, detail: f.detail, status: f.recommended ? 'recommended' : '' })) },
          };
        },
      }),
    ],
  });
}

/** Read-only view of the agent launches. Nothing here can request, approve or send. */
function launchesProvider(store: LaunchStore): ProviderDefinition {
  const brief = z.object({ id: z.string(), purpose: z.string(), status: z.string(), projectKey: z.string(), requestedBy: z.string(), requestedAt: z.string(), startedAt: z.string().nullable(), finishedAt: z.string().nullable(), diagnosisId: z.string().nullable(), steps: z.number(), lastReply: z.string(), error: z.string() });
  return defineProvider({
    name: 'launches',
    title: 'Agent launches',
    description: 'Agents that the incident agent launched in T3 Code after an operator approved (read-only)',
    tools: [
      defineTool({
        name: 'list_agent_launches',
        title: 'List agent launches',
        description: 'Launch requests and the T3 Code agents started from them, newest first, with status, the latest agent reply and any error. Use it to see whether an agent already works on an incident.',
        input: z.object({ status: z.string().optional().describe('Only launches with this status, for example running or pending_approval'), diagnosisId: z.string().optional(), limit: z.number().int().min(1).max(100).default(20) }),
        output: z.object({ launches: z.array(brief) }),
        async run(args) {
          const launches = store
            .list()
            .filter(l => (!args.status || l.status === args.status) && (!args.diagnosisId || l.source.diagnosisId === args.diagnosisId))
            .slice(0, args.limit)
            .map(l => ({
              id: l.id,
              purpose: l.purpose,
              status: l.status,
              projectKey: l.projectKey,
              requestedBy: l.requestedBy,
              requestedAt: l.requestedAt,
              startedAt: l.startedAt ?? null,
              finishedAt: l.finishedAt ?? null,
              diagnosisId: l.source.diagnosisId ?? null,
              steps: l.timeline.length,
              lastReply: (l.lastReply ?? '').slice(0, 1500),
              error: l.error ?? '',
            }));
          return {
            data: { launches },
            summary: `${launches.length} agent launches.`,
            view: { title: 'Agent launches', rows: launches.map(l => ({ label: l.purpose, detail: l.lastReply || l.error, status: l.status })) },
          };
        },
      }),
    ],
  });
}

export class Runtime {
  readonly kube: KubeClient;
  readonly prom: PromClient;
  readonly registry: Registry;
  private readonly settings: Record<string, Record<string, unknown>>;

  constructor(
    readonly config: Config,
    store: DiagnosisStore,
    launches?: LaunchStore,
  ) {
    this.kube = new KubeClient(config);
    this.prom = new PromClient(config.metricsUrl);
    this.settings = loadProviderSettings(config.providerConfigFile);
    this.registry = new Registry(allProviders([diagnosesProvider(store), ...(launches ? [launchesProvider(launches)] : [])]));
  }

  context(provider: ProviderDefinition): ToolContext {
    const vmalertUrl = this.config.vmalertUrl;
    return {
      kube: this.kube,
      prom: this.prom,
      async vmalert(path: string) {
        if (!vmalertUrl) throw new Error('No vmalert endpoint is configured (VMALERT_URL)');
        if (!path.startsWith('/api/v1/')) throw new Error('Only the vmalert /api/v1/ read API is allowed');
        const res = await fetch(`${vmalertUrl}${path}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
        if (!res.ok) throw new Error(`vmalert answered ${res.status}`);
        return res.json();
      },
      serviceGet,
      settings: this.settings[provider.name] ?? {},
      now: new Date(),
    };
  }

  /** The registry as a ToolHost for the in-process diagnosis engine. */
  toolHost(): ToolHost {
    return {
      list: async (): Promise<ToolSpec[]> =>
        [...this.registry.tools.values()]
          .filter(t => t.provider.name !== 'diagnoses' && t.provider.name !== 'launches')
          .map(t => ({ name: t.tool.name, description: t.tool.description, parameters: t.inputJsonSchema })),
      call: async (name, args) => {
        const out = await this.registry.call(name, args, p => this.context(p));
        return { ok: out.ok, summary: out.summary, data: out.data };
      },
    };
  }
}
