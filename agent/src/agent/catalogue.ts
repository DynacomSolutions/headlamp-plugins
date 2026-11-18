import { modelConfigured, type ModelRoute, type ModelRoutesConfig } from '../config.js';
import { routeHeaders } from './model.js';

/** Lists the models each gateway route serves, so a run can pick one. */

export interface CatalogueEntry {
  /** Full id, `<route>/<model>`. */
  id: string;
  route: string;
  model: string;
  name: string;
}

export interface Resolved {
  route: ModelRoute;
  model: string;
}

export class UnknownModelError extends Error {
  constructor(
    readonly requested: string,
    readonly valid: string[],
  ) {
    super(`Unknown model "${requested}".${valid.length ? ` Valid ids: ${valid.join(', ')}` : ' No models are listed.'}`);
  }
}

interface Listed {
  at: number;
  models: Array<{ id: string; name: string }>;
}

const LIST_TIMEOUT_MS = 8000;
const FAILURE_TTL_MS = 30_000;
/** The Codex backend refuses a model list without a client version. */
const CODEX_CLIENT_VERSION = '1.0.0';

/** Reads the model ids from the three list shapes the gateway returns. */
export function parseModelList(body: unknown): Array<{ id: string; name: string }> {
  const items: unknown[] = Array.isArray(body) ? body : Array.isArray((body as any)?.data) ? (body as any).data : Array.isArray((body as any)?.models) ? (body as any).models : [];
  const out: Array<{ id: string; name: string }> = [];
  for (const item of items) {
    if (typeof item === 'string') {
      out.push({ id: item, name: item });
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    const m = item as Record<string, unknown>;
    if (m.visibility === 'hide') continue;
    const id = typeof m.id === 'string' ? m.id : typeof m.slug === 'string' ? m.slug : '';
    if (!id) continue;
    const name = typeof m.display_name === 'string' && m.display_name ? m.display_name : id;
    out.push({ id, name });
  }
  return out;
}

export class ModelCatalogue {
  private readonly cache = new Map<string, Listed>();
  private readonly inflight = new Map<string, Promise<Listed>>();

  constructor(
    private readonly config: ModelRoutesConfig,
    private readonly ttlMs = 10 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** At least one usable route and a default model. */
  get configured(): boolean {
    return modelConfigured(this.config);
  }

  get defaultModel(): string {
    return this.config.defaultModel;
  }

  private fallback(route: ModelRoute): Listed['models'] {
    return (route.models ?? []).map(id => ({ id, name: id }));
  }

  private async fetchList(route: ModelRoute): Promise<Listed['models']> {
    const query = route.style === 'responses' ? `?client_version=${CODEX_CLIENT_VERSION}` : '';
    const headers = routeHeaders(route, 'catalogue');
    delete headers['content-type'];
    let res: Response | undefined;
    for (const path of ['/models', '/v1/models']) {
      res = await fetch(`${route.baseUrl}${path}${query}`, { headers, signal: AbortSignal.timeout(LIST_TIMEOUT_MS) });
      if (res.status !== 404) break;
    }
    if (!res || !res.ok) throw new Error(`Model list answered ${res?.status}`);
    let listed = parseModelList(JSON.parse(await res.text()));
    if (route.models) listed = listed.filter(m => route.models!.includes(m.id));
    if (!listed.length) throw new Error('Model list is empty');
    return listed;
  }

  private load(route: ModelRoute): Promise<Listed> {
    const cached = this.cache.get(route.id);
    if (cached && this.now() - cached.at < this.ttlMs) return Promise.resolve(cached);
    let pending = this.inflight.get(route.id);
    if (!pending) {
      pending = (async () => {
        let models: Listed['models'];
        try {
          models = await this.fetchList(route);
        } catch {
          models = this.fallback(route);
          // A failed listing is remembered briefly, so each run does not wait for the timeout.
          const entry = { at: this.now() - this.ttlMs + FAILURE_TTL_MS, models };
          this.cache.set(route.id, entry);
          return entry;
        }
        const entry = { at: this.now(), models };
        this.cache.set(route.id, entry);
        return entry;
      })().finally(() => this.inflight.delete(route.id));
      this.inflight.set(route.id, pending);
    }
    return pending;
  }

  private async models(route: ModelRoute, waitMs?: number): Promise<Listed['models']> {
    const load = this.load(route).then(l => l.models);
    if (!waitMs) return load;
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<Listed['models']>(resolve => {
      timer = setTimeout(() => resolve(this.cache.get(route.id)?.models ?? this.fallback(route)), waitMs);
    });
    try {
      return await Promise.race([load, late]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Every model of every route. `waitMs` caps how long a slow gateway can delay the answer. */
  async list(options: { waitMs?: number } = {}): Promise<CatalogueEntry[]> {
    const perRoute = await Promise.all(this.config.routes.map(async route => ({ route, models: await this.models(route, options.waitMs) })));
    const out: CatalogueEntry[] = [];
    for (const { route, models } of perRoute) {
      for (const m of models) out.push({ id: `${route.id}/${m.id}`, route: route.id, model: m.id, name: m.name });
    }
    // The default model is always selectable, even when the gateway does not list it.
    const def = this.config.defaultModel;
    if (def && !out.some(e => e.id === def || (!def.includes('/') && e.model === def))) {
      const target = this.qualified(def) ?? this.legacy();
      if (target) {
        const id = `${target.route.id}/${target.model}`;
        if (!out.some(e => e.id === id)) out.push({ id, route: target.route.id, model: target.model, name: target.model });
      }
    }
    return out;
  }

  private qualified(id: string): Resolved | undefined {
    const i = id.indexOf('/');
    if (i <= 0) return undefined;
    const route = this.config.routes.find(r => r.id === id.slice(0, i));
    return route ? { route, model: id.slice(i + 1) } : undefined;
  }

  private legacy(): { route: ModelRoute; model: string } | undefined {
    const route = this.config.routes.find(r => r.id === 'gateway');
    return route && this.config.defaultModel ? { route, model: this.config.defaultModel } : undefined;
  }

  /** The route and model for a run. No id means the default. An unknown id throws UnknownModelError. */
  async resolve(id?: string): Promise<Resolved> {
    if (!this.config.routes.length) throw new Error('No model route is usable. Set AGENT_MODEL_ROUTES_FILE (or AIS_GATEWAY_URL and AIS_GATEWAY_TOKEN).');
    const explicit = id !== undefined && id !== '';
    const target = explicit ? id : this.config.defaultModel;
    if (!target) throw new Error('No default model is set. Set AGENT_MODEL.');
    const q = this.qualified(target);
    if (q) {
      // The operator's default is trusted. A requested id must be in the list when the list is known.
      const known = explicit ? await this.models(q.route) : [];
      if (explicit && known.length && !known.some(m => m.id === q.model)) throw new UnknownModelError(target, await this.validIds());
      return q;
    }
    for (const route of this.config.routes) {
      if ((await this.models(route)).some(m => m.id === target)) return { route, model: target };
    }
    const legacy = this.config.routes.find(r => r.id === 'gateway');
    if (legacy && (!explicit || (await this.models(legacy)).length === 0)) return { route: legacy, model: target };
    throw new UnknownModelError(target, await this.validIds());
  }

  private async validIds(): Promise<string[]> {
    return (await this.list()).map(e => e.id);
  }
}
