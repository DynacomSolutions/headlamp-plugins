import { loadProviderSettings, type Config } from './config.js';
import { KubeClient } from './kube.js';
import { PromClient } from './prom.js';
import { Registry } from './registry.js';
import { allProviders } from './providers/index.js';
import { defineProvider, defineTool, z, type ProviderDefinition, type ToolContext } from './sdk.js';
import type { ToolHost } from './agent/engine.js';
import type { ToolSpec } from './agent/model.js';
import type { DiagnosisStore } from './store.js';

const MAX_BODY = 4 * 1024 * 1024;

/** GET only, to in-cluster Service DNS names only, JSON only. */
export async function serviceGet(url: string): Promise<unknown> {
  const parsed = new URL(url);
  if (!/^https?:$/.test(parsed.protocol)) throw new Error('Only http and https service URLs are allowed');
  if (!/\.svc(\.cluster\.local)?$/.test(parsed.hostname)) throw new Error(`${parsed.hostname} is not an in-cluster Service name (*.svc)`);
  const res = await fetch(parsed, { method: 'GET', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000), redirect: 'error' });
  if (!res.ok) throw new Error(`${parsed.hostname} answered ${res.status}`);
  const text = await res.text();
  if (text.length > MAX_BODY) throw new Error('Service response too large');
  return JSON.parse(text);
}

function diagnosesProvider(store: DiagnosisStore): ProviderDefinition {
  const brief = z.object({ id: z.string(), alert: z.string(), severity: z.string(), status: z.string(), createdAt: z.string(), likelyCause: z.string(), confidence: z.string(), resolved: z.boolean() });
  return defineProvider({
    name: 'diagnoses',
    title: 'Diagnoses',
    description: 'Incident diagnoses the agent has already made (read-only)',
    tools: [
      defineTool({
        name: 'list_diagnoses',
        title: 'List past diagnoses',
        description: 'Diagnoses made so far, newest first, with the likely cause. Check here before investigating an alert that may already be diagnosed.',
        input: z.object({ alert: z.string().optional().describe('Substring of the alert name'), limit: z.number().int().min(1).max(100).default(20) }),
        output: z.object({ diagnoses: z.array(brief) }),
        async run(args) {
          const f = args.alert?.toLowerCase();
          const diagnoses = store
            .list()
            .filter(d => !f || d.alert.name.toLowerCase().includes(f))
            .slice(0, args.limit)
            .map(d => ({
              id: d.id,
              alert: d.alert.name,
              severity: d.alert.severity,
              status: d.status,
              createdAt: d.createdAt,
              likelyCause: d.result?.likelyCause ?? d.error ?? '',
              confidence: d.result?.confidence ?? '',
              resolved: Boolean(d.resolvedAt),
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
          const d = store.get(args.id);
          if (!d) throw new Error(`No diagnosis ${args.id}`);
          const { a2ui: _a2ui, ...rest } = d;
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

export class Runtime {
  readonly kube: KubeClient;
  readonly prom: PromClient;
  readonly registry: Registry;
  private readonly settings: Record<string, Record<string, unknown>>;

  constructor(
    readonly config: Config,
    store: DiagnosisStore,
  ) {
    this.kube = new KubeClient(config);
    this.prom = new PromClient(config.metricsUrl);
    this.settings = loadProviderSettings(config.providerConfigFile);
    this.registry = new Registry(allProviders([diagnosesProvider(store)]));
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
          .filter(t => t.provider.name !== 'diagnoses')
          .map(t => ({ name: t.tool.name, description: t.tool.description, parameters: t.inputJsonSchema })),
      call: async (name, args) => {
        const out = await this.registry.call(name, args, p => this.context(p));
        return { ok: out.ok, summary: out.summary, data: out.data };
      },
    };
  }
}
