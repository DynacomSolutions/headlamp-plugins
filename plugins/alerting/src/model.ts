/** Pure logic: settings, resource shapes, YAML generation, test-send state, state API parsing. */

export const CONFIG_KEY = 'alerting';

export interface Settings {
  group: string;
  version: string;
  namespace: string;
  /** Empty hides the status page. `service/<ns>/<name>:<port>/path` is proxied via the API server. */
  stateApiUrl: string;
  /** GitOps mode: edits become proposals (pull requests), not live writes. */
  gitops: boolean;
  /** URL accepting POST {path, content, message} and returning {prUrl}. Empty means copy/download only. */
  proposalUrl: string;
  /** Repository directory the generated manifests are written under. */
  proposalPath: string;
  /** Also offer to write live custom resources (for clusters not under GitOps). */
  directApply: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  group: 'alerting.example.com',
  version: 'v1alpha1',
  namespace: 'monitoring',
  stateApiUrl: '',
  gitops: true,
  proposalUrl: '',
  proposalPath: 'alerting',
  directApply: false,
};

/** Stored values layered over the defaults; empty strings fall back to the default. */
export function resolveSettings(stored: Partial<Settings> | undefined | null): Settings {
  const out: Settings = { ...DEFAULT_SETTINGS };
  for (const [k, v] of Object.entries(stored || {})) {
    if (v === undefined || v === null) continue;
    if (typeof (DEFAULT_SETTINGS as any)[k] === 'boolean') (out as any)[k] = Boolean(v);
    else if (typeof v === 'string') {
      const t = v.trim();
      if (t !== '' || k === 'stateApiUrl' || k === 'proposalUrl') (out as any)[k] = t;
    }
  }
  return out;
}

export const CHANNEL_TYPES = ['email', 'ntfy', 'pushover', 'webhook'] as const;
export type ChannelType = (typeof CHANNEL_TYPES)[number];
export const ROUTE_KINDS = ['urgent', 'recovery', 'summary'] as const;
export type RouteKind = (typeof ROUTE_KINDS)[number];

export interface SecretRef {
  name: string;
  key: string;
}

export interface ChannelForm {
  name: string;
  type: ChannelType;
  enabled: boolean;
  emailTo: string[];
  ntfyServer: string;
  ntfyTopic: string;
  ntfyPriority: string;
  ntfyTokenSecret: SecretRef;
  pushoverUserKeySecret: SecretRef;
  pushoverTokenSecret: SecretRef;
  webhookUrl: string;
  webhookHeadersSecret: SecretRef;
}

export interface RouteForm {
  name: string;
  channels: string[];
  targets: string[];
  kinds: RouteKind[];
  quietEnabled: boolean;
  quietStart: string;
  quietEnd: string;
  quietTimezone: string;
  quietAllowUrgent: boolean;
}

const emptyRef = (): SecretRef => ({ name: '', key: '' });

export function emptyChannel(): ChannelForm {
  return {
    name: '',
    type: 'email',
    enabled: true,
    emailTo: [],
    ntfyServer: 'https://ntfy.example.com',
    ntfyTopic: '',
    ntfyPriority: '',
    ntfyTokenSecret: emptyRef(),
    pushoverUserKeySecret: emptyRef(),
    pushoverTokenSecret: emptyRef(),
    webhookUrl: '',
    webhookHeadersSecret: emptyRef(),
  };
}

export function emptyRoute(): RouteForm {
  return {
    name: '',
    channels: [],
    targets: [],
    kinds: [],
    quietEnabled: false,
    quietStart: '22:00',
    quietEnd: '07:00',
    quietTimezone: 'UTC',
    quietAllowUrgent: true,
  };
}

const refOf = (r: any): SecretRef => ({ name: r?.name || '', key: r?.key || '' });
const refOut = (r: SecretRef) => ({ name: r.name, key: r.key });
const hasRef = (r: SecretRef) => r.name !== '';

/** Parse a comma or newline separated list, trimming and dropping blanks and duplicates. */
export function parseList(text: string): string[] {
  const seen = new Set<string>();
  for (const part of text.split(/[\n,]/)) {
    const t = part.trim();
    if (t) seen.add(t);
  }
  return [...seen];
}

export function channelFromResource(cr: any): ChannelForm {
  const s = cr?.spec || {};
  const f = emptyChannel();
  f.name = cr?.metadata?.name || '';
  f.type = CHANNEL_TYPES.includes(s.type) ? s.type : 'email';
  f.enabled = s.enabled !== false;
  f.emailTo = Array.isArray(s.email?.to) ? s.email.to.map(String) : [];
  if (s.ntfy) {
    f.ntfyServer = s.ntfy.server || '';
    f.ntfyTopic = s.ntfy.topic || '';
    f.ntfyPriority = s.ntfy.priority === undefined ? '' : String(s.ntfy.priority);
    f.ntfyTokenSecret = refOf(s.ntfy.tokenSecretRef);
  }
  if (s.pushover) {
    f.pushoverUserKeySecret = refOf(s.pushover.userKeySecretRef);
    f.pushoverTokenSecret = refOf(s.pushover.tokenSecretRef);
  }
  if (s.webhook) {
    f.webhookUrl = s.webhook.url || '';
    f.webhookHeadersSecret = refOf(s.webhook.headersSecretRef);
  }
  return f;
}

export function routeFromResource(cr: any): RouteForm {
  const s = cr?.spec || {};
  const f = emptyRoute();
  f.name = cr?.metadata?.name || '';
  f.channels = Array.isArray(s.channels) ? s.channels.map(String) : [];
  f.targets = Array.isArray(s.match?.targets) ? s.match.targets.map(String) : [];
  f.kinds = Array.isArray(s.match?.kinds)
    ? s.match.kinds.filter((k: any) => ROUTE_KINDS.includes(k))
    : [];
  if (s.quietHours) {
    f.quietEnabled = true;
    f.quietStart = s.quietHours.start || f.quietStart;
    f.quietEnd = s.quietHours.end || f.quietEnd;
    f.quietTimezone = s.quietHours.timezone || f.quietTimezone;
    f.quietAllowUrgent = s.quietHours.allowUrgent === true;
  }
  return f;
}

const apiVersion = (s: Settings) => `${s.group}/${s.version}`;

export function channelResource(f: ChannelForm, s: Settings): any {
  const spec: any = { type: f.type, enabled: f.enabled };
  if (f.type === 'email') spec.email = { to: f.emailTo };
  if (f.type === 'ntfy') {
    const n: any = { server: f.ntfyServer, topic: f.ntfyTopic };
    if (f.ntfyPriority.trim() !== '')
      n.priority = /^\d+$/.test(f.ntfyPriority.trim())
        ? Number(f.ntfyPriority)
        : f.ntfyPriority.trim();
    if (hasRef(f.ntfyTokenSecret)) n.tokenSecretRef = refOut(f.ntfyTokenSecret);
    spec.ntfy = n;
  }
  if (f.type === 'pushover') {
    spec.pushover = {
      userKeySecretRef: refOut(f.pushoverUserKeySecret),
      tokenSecretRef: refOut(f.pushoverTokenSecret),
    };
  }
  if (f.type === 'webhook') {
    const w: any = { url: f.webhookUrl };
    if (hasRef(f.webhookHeadersSecret)) w.headersSecretRef = refOut(f.webhookHeadersSecret);
    spec.webhook = w;
  }
  return {
    apiVersion: apiVersion(s),
    kind: 'NotificationChannel',
    metadata: { name: f.name, namespace: s.namespace },
    spec,
  };
}

export function routeResource(f: RouteForm, s: Settings): any {
  const match: any = {};
  if (f.targets.length) match.targets = f.targets;
  if (f.kinds.length) match.kinds = f.kinds;
  const spec: any = { channels: f.channels, match };
  if (f.quietEnabled) {
    spec.quietHours = {
      start: f.quietStart,
      end: f.quietEnd,
      timezone: f.quietTimezone,
      allowUrgent: f.quietAllowUrgent,
    };
  }
  return {
    apiVersion: apiVersion(s),
    kind: 'AlertRoute',
    metadata: { name: f.name, namespace: s.namespace },
    spec,
  };
}

const DNS_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

/** Returns a list of human-readable problems; empty means valid. */
export function validateChannel(f: ChannelForm): string[] {
  const e: string[] = [];
  if (!f.name || !DNS_LABEL.test(f.name)) e.push('Name must be a lower-case DNS label.');
  if (f.type === 'email') {
    if (f.emailTo.length === 0) e.push('At least one recipient is required.');
    else if (f.emailTo.some(a => !/^[^@\s]+@[^@\s]+$/.test(a)))
      e.push('Recipients must be email addresses.');
  }
  if (f.type === 'ntfy') {
    if (!/^https?:\/\//.test(f.ntfyServer)) e.push('ntfy server must be an http(s) URL.');
    if (!f.ntfyTopic) e.push('ntfy topic is required.');
    if (hasRef(f.ntfyTokenSecret) && !f.ntfyTokenSecret.key)
      e.push('Choose a key for the ntfy token secret.');
  }
  if (f.type === 'pushover') {
    for (const [label, r] of [
      ['user key', f.pushoverUserKeySecret],
      ['token', f.pushoverTokenSecret],
    ] as const) {
      if (!r.name || !r.key) e.push(`Pushover ${label} secret and key are required.`);
    }
  }
  if (f.type === 'webhook') {
    if (!/^https?:\/\//.test(f.webhookUrl)) e.push('Webhook URL must be an http(s) URL.');
    if (hasRef(f.webhookHeadersSecret) && !f.webhookHeadersSecret.key)
      e.push('Choose a key for the headers secret.');
  }
  return e;
}

export function validateRoute(f: RouteForm): string[] {
  const e: string[] = [];
  if (!f.name || !DNS_LABEL.test(f.name)) e.push('Name must be a lower-case DNS label.');
  if (f.channels.length === 0) e.push('Select at least one channel.');
  if (f.quietEnabled) {
    if (
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(f.quietStart) ||
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(f.quietEnd)
    )
      e.push('Quiet hours start and end must be HH:MM.');
    if (!f.quietTimezone) e.push('Quiet hours need a timezone.');
  }
  return e;
}

/* ---------- YAML ---------- */

const PLAIN = /^[A-Za-z_][A-Za-z0-9_./@-]*$/;
const RESERVED = /^(true|false|null|yes|no|on|off|~|y|n)$/i;

function scalar(v: any): string {
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v === null || v === undefined) return 'null';
  const s = String(v);
  if (s !== '' && PLAIN.test(s) && !RESERVED.test(s)) return s;
  return JSON.stringify(s);
}

function emit(v: any, indent: number, out: string[]): void {
  const pad = ' '.repeat(indent);
  if (Array.isArray(v)) {
    for (const item of v) {
      if (item && typeof item === 'object') {
        const sub: string[] = [];
        emit(item, indent + 2, sub);
        sub[0] = pad + '- ' + sub[0].slice(indent + 2);
        out.push(...sub);
      } else out.push(`${pad}- ${scalar(item)}`);
    }
    return;
  }
  for (const [k, val] of Object.entries(v)) {
    if (val === undefined) continue;
    const key = scalar(k);
    if (Array.isArray(val)) {
      if (val.length === 0) out.push(`${pad}${key}: []`);
      else {
        out.push(`${pad}${key}:`);
        emit(val, indent + 2, out);
      }
    } else if (val && typeof val === 'object') {
      if (Object.keys(val).length === 0) out.push(`${pad}${key}: {}`);
      else {
        out.push(`${pad}${key}:`);
        emit(val, indent + 2, out);
      }
    } else out.push(`${pad}${key}: ${scalar(val)}`);
  }
}

/** Deterministic block-style YAML for plain JSON-like data (insertion order preserved). */
export function toYaml(obj: any): string {
  const out: string[] = [];
  emit(obj, 0, out);
  return out.join('\n') + '\n';
}

export function manifestPath(base: string, kind: string, name: string): string {
  const dir = base.replace(/^\/+|\/+$/g, '');
  const file = `${
    kind === 'NotificationChannel' ? 'notificationchannel' : 'alertroute'
  }-${name}.yaml`;
  return dir ? `${dir}/${file}` : file;
}

export function proposalBody(
  kind: string,
  name: string,
  yaml: string,
  base: string,
  existed: boolean
) {
  return {
    path: manifestPath(base, kind, name),
    content: yaml,
    message: `alerting: ${existed ? 'update' : 'add'} ${kind} ${name}`,
  };
}

/* ---------- test send ---------- */

export const testRequestedKey = (s: Pick<Settings, 'group'>) => `${s.group}/test-requested`;
export const testHandledKey = (s: Pick<Settings, 'group'>) => `${s.group}/test-handled`;

export function testRequestPatch(s: Pick<Settings, 'group'>, now: Date = new Date()) {
  return { metadata: { annotations: { [testRequestedKey(s)]: now.toISOString() } } };
}

export interface TestState {
  state: 'none' | 'pending' | 'handled';
  requested?: string;
  result?: string;
  error?: string;
  sentAt?: string;
}

/** Pending until test-handled equals test-requested, then the status result applies. */
export function testState(cr: any, s: Pick<Settings, 'group'>): TestState {
  const ann = cr?.metadata?.annotations || {};
  const requested = ann[testRequestedKey(s)];
  if (!requested) return { state: 'none' };
  if (ann[testHandledKey(s)] !== requested) return { state: 'pending', requested };
  const st = cr?.status || {};
  return {
    state: 'handled',
    requested,
    result: st.lastResult,
    error: st.lastError,
    sentAt: st.lastSendTime,
  };
}

/* ---------- service proxy ---------- */

/**
 * `service/<ns>/<name>:<port>/path` becomes an API-server proxy path; anything else is returned
 * untouched with `proxied: false`.
 */
export function resolveEndpoint(url: string): { url: string; proxied: boolean } {
  const m = /^service\/([^/]+)\/([^/:]+)(?::([^/]+))?(\/.*)?$/.exec(url.trim());
  if (!m) return { url: url.trim(), proxied: false };
  const [, ns, name, port, path] = m;
  const svc = port ? `${name}:${port}` : name;
  return { url: `/api/v1/namespaces/${ns}/services/${svc}/proxy${path || '/'}`, proxied: true };
}

/* ---------- state API ---------- */

export interface Episode {
  start?: string;
  end?: string;
  state?: string;
  detail?: string;
}
export interface TargetState {
  name: string;
  kind?: string;
  state: string;
  since?: string;
  detail?: string;
  episodes: Episode[];
}

const str = (v: any) => (v === undefined || v === null || v === '' ? undefined : String(v));

/** Tolerant parse: accepts {targets: [...]} or a bare array. */
export function parseState(json: any): TargetState[] {
  const list = Array.isArray(json) ? json : Array.isArray(json?.targets) ? json.targets : [];
  return list.map((t: any): TargetState => {
    const eps = Array.isArray(t?.episodes)
      ? t.episodes
      : Array.isArray(t?.recentEpisodes)
      ? t.recentEpisodes
      : [];
    return {
      name: String(t?.name ?? t?.target ?? t?.id ?? ''),
      kind: str(t?.kind ?? t?.type),
      state: String(t?.state ?? t?.status ?? 'unknown'),
      since: str(t?.since ?? t?.stateSince ?? t?.lastChange),
      detail: str(t?.detail ?? t?.message),
      episodes: eps.map((e: any) => ({
        start: str(e?.start ?? e?.startedAt ?? e?.from),
        end: str(e?.end ?? e?.endedAt ?? e?.to ?? e?.resolvedAt),
        state: str(e?.state ?? e?.kind),
        detail: str(e?.detail ?? e?.message ?? e?.reason),
      })),
    };
  });
}

/** Healthy-ish states render green, down-ish red, anything else amber. */
export function stateSeverity(state: string): 'success' | 'error' | 'warning' {
  const s = state.toLowerCase();
  if (['up', 'ok', 'healthy', 'recovered', 'resolved', 'normal'].includes(s)) return 'success';
  if (['down', 'firing', 'failed', 'critical', 'alerting', 'urgent', 'error'].includes(s))
    return 'error';
  return 'warning';
}
