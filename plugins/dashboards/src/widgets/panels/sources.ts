/*
 * Panel sources: the places the panel widgets read panels from. The first source is the built-in
 * `agent`. It comes from the three agent location settings of earlier versions, so a saved
 * setting keeps working and no value is copied or lost. Other sources come from two places:
 *  - the cluster: the ConfigMap `dashboard-sources` in the dashboards namespace, shared by every
 *    browser (see `clusterSources.ts`);
 *  - the browser: a list under `panelSources` in the Dashboards plugin settings.
 * On an id clash the browser entry wins.
 *
 * A source is one of two kinds:
 *  - `service`: a Kubernetes Service, reached through the API service proxy. RBAC is the guard.
 *  - `url`: a base URL that the browser calls with `fetch` and `credentials: 'include'`, so the
 *    cookie login of the app works. No token is stored in the settings.
 */
import { isIconName } from '../../icons/iconNames';

export const AGENT_SOURCE_ID = 'agent';
export const SOURCES_KEY = 'panelSources';

/** The ConfigMap that holds the cluster sources, its label and its data key. */
export const CLUSTER_SOURCES_NAME = 'dashboard-sources';
export const CLUSTER_SOURCES_LABEL = 'headlamp.dev/dashboard-sources';
export const CLUSTER_SOURCES_KEY = 'sources.json';
/** Limits for the content of the ConfigMap, which is untrusted. */
export const MAX_CLUSTER_SOURCES = 50;
export const MAX_CLUSTER_TEXT = 64 * 1024;
const MAX_TITLE = 80;

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
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

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
  return raw.filter(isObject).map(toDraft);
}

/** One stored entry as a draft. Fields of the wrong type become blank. */
export function toDraft(r: Record<string, unknown>): SourceDraft {
  return {
    id: typeof r.id === 'string' ? r.id : '',
    title: typeof r.title === 'string' ? r.title : '',
    icon: typeof r.icon === 'string' ? r.icon : '',
    kind: r.kind === 'url' ? 'url' : 'service',
    namespace: typeof r.namespace === 'string' ? r.namespace : '',
    service: typeof r.service === 'string' ? r.service : '',
    port: typeof r.port === 'string' ? r.port : typeof r.port === 'number' ? String(r.port) : '',
    pathPrefix: typeof r.pathPrefix === 'string' ? r.pathPrefix : '',
    baseUrl: typeof r.baseUrl === 'string' ? r.baseUrl : '',
  };
}

const DNS_LABEL = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;
const PORT_NAME = /^(?=.*[a-z])[a-z0-9]([-a-z0-9]{0,13}[a-z0-9])?$/;
const PATH_SEGMENT = /^[A-Za-z0-9._~-]+$/;

const isPortNumber = (v: string): boolean => /^\d{1,5}$/.test(v) && +v >= 1 && +v <= 65535;

/**
 * A path prefix is safe when each segment uses only URL-safe characters and none is `.` or `..`.
 * A segment such as `..` would climb out of the service proxy path.
 */
function isSafePrefix(prefix: string): boolean {
  const p = normalisePrefix(prefix);
  if (p === '') return true;
  if (p.length > 200) return false;
  return p
    .slice(1)
    .split('/')
    .every(seg => PATH_SEGMENT.test(seg) && seg !== '.' && seg !== '..');
}

/** The short reason a draft cannot be used, or null when it is valid. `taken` holds the ids of the other sources. */
export function draftProblem(d: SourceDraft, taken: ReadonlyArray<string> = []): string | null {
  const id = d.id.trim();
  if (!isSourceId(id))
    return 'The id must use lower case letters, digits, dashes or underscores, and start with a letter or digit.';
  if (id === AGENT_SOURCE_ID || taken.includes(id))
    return 'This id is already used by another source.';
  if (d.title.trim().length > MAX_TITLE)
    return `The title must have at most ${MAX_TITLE} characters.`;
  if (d.icon.trim() !== '' && !isIconName(d.icon.trim()))
    return 'The icon must be an mdi: name, for example mdi:server.';
  if (d.kind === 'url') {
    try {
      const u = new URL(d.baseUrl.trim());
      if (u.protocol !== 'https:' && u.protocol !== 'http:')
        return 'The URL must start with https:// or http://.';
      if (u.username !== '' || u.password !== '')
        return 'The URL must not hold a user name or a password.';
    } catch {
      return 'Enter a full URL, for example https://my-app.example.com.';
    }
    return null;
  }
  if (d.namespace.trim() === '') return 'The namespace is required.';
  if (!DNS_LABEL.test(d.namespace.trim()))
    return 'The namespace must be a valid Kubernetes name: lower case letters, digits and dashes.';
  if (d.service.trim() === '') return 'The service is required.';
  if (!DNS_LABEL.test(d.service.trim()))
    return 'The service must be a valid Kubernetes name: lower case letters, digits and dashes.';
  if (d.port.trim() === '') return 'The port is required.';
  if (!isPortNumber(d.port.trim()) && !PORT_NAME.test(d.port.trim()))
    return 'The port must be a number from 1 to 65535, or a port name.';
  if (!isSafePrefix(d.pathPrefix))
    return 'The path prefix may use letters, digits and - . _ ~ only, and no . or .. segment.';
  return null;
}

/** A valid draft as a source. Call it only when `draftProblem` gave null. */
export function draftToSource(d: SourceDraft): PanelSource {
  const id = d.id.trim();
  const title = d.title.trim() === '' ? id : d.title.trim();
  const icon = d.icon.trim() === '' ? undefined : d.icon.trim();
  if (d.kind === 'url')
    return { id, title, icon, kind: 'url', baseUrl: d.baseUrl.trim().replace(/\/+$/, '') };
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

/** The valid browser sources. An invalid or repeated id is skipped. */
export function localSources(stored: Record<string, unknown> | undefined): PanelSource[] {
  const out: PanelSource[] = [];
  const seen = new Set<string>([AGENT_SOURCE_ID]);
  for (const d of readDrafts(stored)) {
    if (draftProblem(d, [...seen]) !== null) continue;
    const s = draftToSource(d);
    seen.add(s.id);
    out.push(s);
  }
  return out;
}

/**
 * Every usable source: the agent first, then the cluster sources, then the browser sources. On an
 * id clash the browser source wins, so the cluster source of that id is left out.
 */
export function resolveSources(
  stored: Record<string, unknown> | undefined,
  cluster: ReadonlyArray<PanelSource> = []
): PanelSource[] {
  const locals = localSources(stored);
  const local = new Set(locals.map(s => s.id));
  const shared = cluster.filter(s => s.id !== AGENT_SOURCE_ID && !local.has(s.id));
  return [agentSource(stored), ...shared, ...locals];
}

/** The ids of the cluster sources that a browser source overrides. */
export function overriddenClusterIds(
  stored: Record<string, unknown> | undefined,
  cluster: ReadonlyArray<PanelSource>
): Set<string> {
  const local = new Set(localSources(stored).map(s => s.id));
  return new Set(cluster.filter(s => local.has(s.id)).map(s => s.id));
}

export interface ParsedClusterSources {
  sources: PanelSource[];
  /** Why the file or an entry was not used. Short texts that are safe to show. */
  problems: string[];
}

const shortId = (v: unknown): string =>
  typeof v === 'string' && v.trim() !== '' ? `"${v.trim().slice(0, 40)}"` : 'without an id';

/**
 * The content of `sources.json` as sources. The text is untrusted: anything that does not pass the
 * same rules as a browser source (see `draftProblem`) is left out with a short reason, and the
 * rest is used. The result is never an exception.
 */
export function parseClusterSources(text: unknown): ParsedClusterSources {
  const fail = (m: string): ParsedClusterSources => ({ sources: [], problems: [m] });
  if (typeof text !== 'string') return fail(`The ConfigMap has no "${CLUSTER_SOURCES_KEY}" key.`);
  if (text.length > MAX_CLUSTER_TEXT)
    return fail(`"${CLUSTER_SOURCES_KEY}" is larger than ${MAX_CLUSTER_TEXT / 1024} KiB.`);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return fail(`"${CLUSTER_SOURCES_KEY}" is not valid JSON.`);
  }
  if (!isObject(json)) return fail(`"${CLUSTER_SOURCES_KEY}" must be an object.`);
  if (json.version !== 1)
    return fail(
      `"${CLUSTER_SOURCES_KEY}" has an unsupported version. This plugin reads version 1.`
    );
  if (!Array.isArray(json.sources)) return fail(`"${CLUSTER_SOURCES_KEY}" has no "sources" list.`);
  const sources: PanelSource[] = [];
  const problems: string[] = [];
  const seen = new Set<string>([AGENT_SOURCE_ID]);
  json.sources.slice(0, MAX_CLUSTER_SOURCES).forEach((entry: unknown) => {
    if (!isObject(entry)) {
      problems.push('An entry that is not an object was ignored.');
      return;
    }
    const d = toDraft(entry);
    const problem = draftProblem(d, [...seen]);
    if (problem !== null) {
      problems.push(`The source ${shortId(entry.id)} was ignored. ${problem}`);
      return;
    }
    const s = draftToSource(d);
    seen.add(s.id);
    sources.push(s);
  });
  if (json.sources.length > MAX_CLUSTER_SOURCES)
    problems.push(`Only the first ${MAX_CLUSTER_SOURCES} sources are used.`);
  return { sources, problems };
}

/** The text of `sources.json` for a list of sources. */
export const serialiseClusterSources = (sources: ReadonlyArray<PanelSource>): string =>
  `${JSON.stringify({ version: 1, sources }, null, 2)}\n`;

export const findSource = (
  sources: ReadonlyArray<PanelSource>,
  id: string
): PanelSource | undefined => sources.find(s => s.id === id);

const enc = encodeURIComponent;

/** The address of a path (such as `/api/widgets`) on a source. A service gives a proxy path. A URL gives an absolute URL. */
export function sourceUrl(source: PanelSource, path: string): string {
  const tail = path.startsWith('/') ? path : `/${path}`;
  if (source.kind === 'url') return `${source.baseUrl.replace(/\/+$/, '')}${tail}`;
  const svc = source.port ? `${enc(source.service)}:${enc(source.port)}` : enc(source.service);
  return `/api/v1/namespaces/${enc(source.namespace)}/services/${svc}/proxy${normalisePrefix(
    source.pathPrefix
  )}${tail}`;
}

export const listUrl = (s: PanelSource): string => sourceUrl(s, '/api/widgets');
export const panelUrl = (s: PanelSource, id: string): string =>
  sourceUrl(s, `/api/widgets/${enc(id)}`);

/** A stable key for a source's location, for caches and effect dependencies. */
export const sourceKey = (s: PanelSource): string => listUrl(s);

/**
 * The address of a row icon. `path` is relative to the source's `/api/widgets/` base and must have
 * passed `safeIconPath`, so each segment is URL-safe and no `..` can climb out of the base.
 */
export const iconUrl = (s: PanelSource, path: string): string =>
  sourceUrl(s, `/api/widgets/${path.split('/').map(enc).join('/')}`);
