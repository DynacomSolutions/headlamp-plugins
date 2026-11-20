/*
 * Panel sources: the places the panel widgets read panels from. The first source is the built-in
 * `agent`. It comes from the three agent location settings of earlier versions, so a saved
 * setting keeps working and no value is copied or lost. Other sources are stored as a list
 * under `panelSources` in the Dashboards plugin settings.
 *
 * A source is one of two kinds:
 *  - `service`: a Kubernetes Service, reached through the API service proxy. RBAC is the guard.
 *  - `url`: a base URL that the browser calls with `fetch` and `credentials: 'include'`, so the
 *    cookie login of the app works. No token is stored in the settings.
 */
import { isIconName } from '../../icons/iconNames';

export const AGENT_SOURCE_ID = 'agent';
export const SOURCES_KEY = 'panelSources';

export interface ServiceSource {
  id: string;
  title: string;
  icon?: string;
  kind: 'service';
  namespace: string;
  service: string;
  port: string;
  /** Empty, or a path such as `/my-app`. It sits between `/proxy` and `/api/widgets`. */
  pathPrefix: string;
}

export interface UrlSource {
  id: string;
  title: string;
  icon?: string;
  kind: 'url';
  /** For example `https://my-app.example.com`. The panel paths are added to it. */
  baseUrl: string;
}

export type PanelSource = ServiceSource | UrlSource;

export const DEFAULT_AGENT = {
  namespace: 'headlamp-agent',
  service: 'headlamp-agent',
  port: '80',
};

const trimmed = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A source id: lower case letters, digits, dashes and underscores. It goes into widget types, so keep it simple. */
export const isSourceId = (s: string): boolean => /^[a-z0-9][a-z0-9_-]{0,39}$/.test(s);

/** The path prefix with one leading slash and no trailing slash. Blank stays blank. */
export function normalisePrefix(prefix: string): string {
  const p = prefix.trim().replace(/^\/+/, '').replace(/\/+$/, '');
  return p === '' ? '' : `/${p}`;
}

/** The built-in agent source, from the legacy agent settings. A blank field uses the default. */
export function agentSource(stored: Record<string, unknown> | undefined): ServiceSource {
  const pick = (value: unknown, fallback: string): string => {
    // A number is a valid port from an old settings file.
    const v = typeof value === 'number' ? String(value) : trimmed(value);
    return v === '' ? fallback : v;
  };
  return {
    id: AGENT_SOURCE_ID,
    title: 'Agent',
    kind: 'service',
    namespace: pick(stored?.agentNamespace, DEFAULT_AGENT.namespace),
    service: pick(stored?.agentService, DEFAULT_AGENT.service),
    port: pick(stored?.agentPort, DEFAULT_AGENT.port),
    pathPrefix: '',
  };
}

/** A source as stored, filled out with defaults so the editor can show a half-written one. */
export type SourceDraft = {
  id: string;
  title: string;
  icon: string;
  kind: 'service' | 'url';
  namespace: string;
  service: string;
  port: string;
  pathPrefix: string;
  baseUrl: string;
};

export const blankDraft = (id = ''): SourceDraft => ({
  id,
  title: '',
  icon: '',
  kind: 'service',
  namespace: '',
  service: '',
  port: '80',
  pathPrefix: '',
  baseUrl: '',
});

/** The stored source list as drafts. Entries that are not objects are dropped. */
export function readDrafts(stored: Record<string, unknown> | undefined): SourceDraft[] {
  const raw = stored?.[SOURCES_KEY];
  if (!Array.isArray(raw)) return [];
  return raw.filter(isObject).map(r => ({
    id: typeof r.id === 'string' ? r.id : '',
    title: typeof r.title === 'string' ? r.title : '',
    icon: typeof r.icon === 'string' ? r.icon : '',
    kind: r.kind === 'url' ? 'url' : 'service',
    namespace: typeof r.namespace === 'string' ? r.namespace : '',
    service: typeof r.service === 'string' ? r.service : '',
    port: typeof r.port === 'string' ? r.port : typeof r.port === 'number' ? String(r.port) : '',
    pathPrefix: typeof r.pathPrefix === 'string' ? r.pathPrefix : '',
    baseUrl: typeof r.baseUrl === 'string' ? r.baseUrl : '',
  }));
}

/** The short reason a draft cannot be used, or null when it is valid. `taken` holds the ids of the other sources. */
export function draftProblem(d: SourceDraft, taken: ReadonlyArray<string> = []): string | null {
  const id = d.id.trim();
  if (!isSourceId(id)) return 'The id must use lower case letters, digits, dashes or underscores, and start with a letter or digit.';
  if (id === AGENT_SOURCE_ID || taken.includes(id)) return 'This id is already used by another source.';
  if (d.icon.trim() !== '' && !isIconName(d.icon.trim())) return 'The icon must be an mdi: name, for example mdi:server.';
  if (d.kind === 'url') {
    try {
      const u = new URL(d.baseUrl.trim());
      if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'The URL must start with https:// or http://.';
    } catch {
      return 'Enter a full URL, for example https://my-app.example.com.';
    }
    return null;
  }
  if (d.namespace.trim() === '') return 'The namespace is required.';
  if (d.service.trim() === '') return 'The service is required.';
  if (d.port.trim() === '') return 'The port is required.';
  return null;
}

/** A valid draft as a source. Call it only when `draftProblem` gave null. */
export function draftToSource(d: SourceDraft): PanelSource {
  const id = d.id.trim();
  const title = d.title.trim() === '' ? id : d.title.trim();
  const icon = d.icon.trim() === '' ? undefined : d.icon.trim();
  if (d.kind === 'url') return { id, title, icon, kind: 'url', baseUrl: d.baseUrl.trim().replace(/\/+$/, '') };
  return {
    id,
    title,
    icon,
    kind: 'service',
    namespace: d.namespace.trim(),
    service: d.service.trim(),
    port: d.port.trim(),
    pathPrefix: normalisePrefix(d.pathPrefix),
  };
}

/** Every usable source: the agent first, then the valid stored ones. An invalid or repeated id is skipped. */
export function resolveSources(stored: Record<string, unknown> | undefined): PanelSource[] {
  const out: PanelSource[] = [agentSource(stored)];
  const seen = new Set<string>([AGENT_SOURCE_ID]);
  for (const d of readDrafts(stored)) {
    if (draftProblem(d, [...seen]) !== null) continue;
    const s = draftToSource(d);
    seen.add(s.id);
    out.push(s);
  }
  return out;
}

export const findSource = (sources: ReadonlyArray<PanelSource>, id: string): PanelSource | undefined => sources.find(s => s.id === id);

const enc = encodeURIComponent;

/** The address of a path (such as `/api/widgets`) on a source. A service gives a proxy path. A URL gives an absolute URL. */
export function sourceUrl(source: PanelSource, path: string): string {
  const tail = path.startsWith('/') ? path : `/${path}`;
  if (source.kind === 'url') return `${source.baseUrl.replace(/\/+$/, '')}${tail}`;
  const svc = source.port ? `${enc(source.service)}:${enc(source.port)}` : enc(source.service);
  return `/api/v1/namespaces/${enc(source.namespace)}/services/${svc}/proxy${normalisePrefix(source.pathPrefix)}${tail}`;
}

export const listUrl = (s: PanelSource): string => sourceUrl(s, '/api/widgets');
export const panelUrl = (s: PanelSource, id: string): string => sourceUrl(s, `/api/widgets/${enc(id)}`);

/** A stable key for a source's location, for caches and effect dependencies. */
export const sourceKey = (s: PanelSource): string => listUrl(s);
