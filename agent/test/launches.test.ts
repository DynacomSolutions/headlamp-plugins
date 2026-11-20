import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Diagnosis } from '../src/agent/report.js';
import { loadConfig, parseLaunchSettings, type LaunchConfig } from '../src/config.js';
import { buildBrief, fixCitesPlan } from '../src/launch/brief.js';
import { LaunchError, LaunchService } from '../src/launch/service.js';
import { LaunchStore, type Launch } from '../src/launch/store.js';
import { mapProjection } from '../src/launch/timeline.js';
import { Runtime } from '../src/runtime.js';
import { startServer } from '../src/server.js';
import { DiagnosisStore } from '../src/store.js';
import { T3Client, tokenFromFile } from '../src/t3/client.js';
import { startFakeT3, type FakeT3 } from './helpers/fake-t3.js';

const FAKE_SECRET = ['gh', 'p_', 'a'.repeat(30)].join('');
const plan = { applyMode: 'propose-only', zone: 'example.com', changes: [{ host: 'app.example.com', reason: 'The rules want worker-1.', remove: [{ node: 'worker-2', ip: '192.0.2.2', type: 'A' }], add: [{ node: 'worker-1', ip: '192.0.2.1', type: 'A' }], useWildcard: false }], steps: ['Change only the listed records.'] };

function diagnosis(id = 'd1', extra: Partial<Diagnosis> = {}): Diagnosis {
  return {
    id,
    createdAt: '2026-11-20T05:00:00.000Z',
    status: 'done',
    source: 'webhook',
    alert: { name: 'DnsPlacementDrift', severity: 'warning', labels: { host: 'app.example.com' }, annotations: {}, startsAt: '2026-11-20T05:00:00Z', fingerprint: 'f' },
    evidence: [
      { id: 'e1', tool: 'dns_placement_status', reason: 'r', summary: 'One host drifts.', ok: true },
      { id: 'e2', tool: 'dns_placement_plan', reason: 'r', summary: '1 host to change (propose-only).', ok: true, data: plan },
      { id: 'e3', tool: 'list_events', reason: 'r', summary: 'No events.', ok: true },
    ],
    result: {
      summary: 'The host points at the wrong node.',
      likelyCause: 'DNS records drift from the rules.',
      confidence: 'high',
      signals: [{ text: 'DNS has worker-2', evidence: ['e1'], holds: true }],
      fixes: [
        { title: 'Apply the DNS placement plan', detail: 'Use the plan from e2 and move the records.', recommended: true },
        { title: 'Restart the pod', detail: 'Restart the web pod.', recommended: false },
      ],
      verify: 'The placement check passes.',
    },
    toolCalls: 2,
    toolBudget: 10,
    model: 'gateway/m1',
    a2ui: [],
    ...extra,
  };
}

let dir: string;
let fake: FakeT3;
let tokenFile: string;
let diagnoses: DiagnosisStore;
let launchStore: LaunchStore;
let services: LaunchService[];

const launchConfig = (extra: Partial<LaunchConfig['settings']> = {}): LaunchConfig => ({
  t3Url: fake.url,
  t3TokenFile: tokenFile,
  settingsFile: '',
  settings: parseLaunchSettings({
    projects: { default: { projectId: 'project-0', title: 'Main project' }, other: { projectId: 'project-1', title: 'Other project' } },
    model: { instanceId: 'provider-0', model: 'model-0' },
    briefPreamble: 'You work for the operators of this cluster.',
    maxRunning: 2,
    threadUrlTemplate: 'https://t3.example.com/thread/{threadId}',
    ...extra,
  }),
});

function service(config = launchConfig(), store = launchStore): LaunchService {
  const s = new LaunchService({ store, diagnoses, config, t3: new T3Client({ url: fake.url, readToken: tokenFromFile(tokenFile) }), pollMs: 5, maxBackoffMs: 10, maxErrors: 3 });
  services.push(s);
  return s;
}

const until = async (fn: () => boolean, ms = 3000) => {
  for (let i = 0; i < ms / 5 && !fn(); i++) await new Promise(r => setTimeout(r, 5));
  expect(fn()).toBe(true);
};

const run = (id: string, status: string, extra: Record<string, unknown> = {}) => ({ id, ordinal: Number(id.replace(/\D/g, '')) || 1, status, requestedAt: '2026-11-20T07:00:00.000Z', startedAt: '2026-11-20T07:00:01.000Z', completedAt: null, ...extra });

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agent-launches-'));
  fake = await startFakeT3();
  tokenFile = join(dir, 'token');
  writeFileSync(tokenFile, fake.token);
  diagnoses = new DiagnosisStore('', 50);
  diagnoses.put(diagnosis());
  launchStore = new LaunchStore(dir, 200);
  services = [];
});
afterEach(async () => {
  for (const s of services) s.shutdown();
  await fake.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('launch config', () => {
  it('is off without T3_URL, a token file or a default project, and says why', () => {
    const reasons = [
      { ...launchConfig(), t3Url: '' },
      { ...launchConfig(), t3TokenFile: '' },
      { ...launchConfig(), t3TokenFile: join(dir, 'missing') },
      { ...launchConfig(), settings: parseLaunchSettings({ projects: { other: { projectId: 'p', title: 't' } }, model: { instanceId: 'a', model: 'b' } }) },
      { ...launchConfig(), settingsError: 'The launch settings file is not valid JSON' },
    ].map(c => service(c).publicConfig());
    expect(reasons.every(r => !r.enabled)).toBe(true);
    expect(reasons.map(r => r.reason)).toEqual(['T3_URL is not set', 'T3_TOKEN_FILE is not set', 'The T3 token file does not exist', 'The launch settings have no default project', 'The launch settings file is not valid JSON']);
  });

  it('shows project keys and titles only, never project ids', () => {
    const c = service().publicConfig();
    expect(c).toEqual({ enabled: true, projects: [{ key: 'default', title: 'Main project' }, { key: 'other', title: 'Other project' }], model: { instanceId: 'provider-0', model: 'model-0' }, threadUrlTemplate: 'https://t3.example.com/thread/{threadId}' });
    expect(JSON.stringify(c)).not.toContain('project-0');
  });

  it('refuses a request while launching is off', () => {
    const s = service({ ...launchConfig(), t3Url: '' });
    expect(() => s.create({ purpose: 'x' }, 'op')).toThrow(LaunchError);
    try {
      s.create({ purpose: 'x' }, 'op');
    } catch (e) {
      expect((e as LaunchError).status).toBe(503);
    }
  });

  it('drops a threadUrlTemplate that is not http(s) and clamps maxRunning', () => {
    const s = parseLaunchSettings({ projects: {}, threadUrlTemplate: 'javascript:alert({threadId})', maxRunning: 0 });
    expect(s.threadUrlTemplate).toBe('');
    expect(s.maxRunning).toBe(2);
  });
});

describe('brief builder', () => {
  it('holds the preamble, purpose, cause, cited facts, the fix and the full DNS plan', () => {
    const d = diagnosis();
    const brief = buildBrief({ preamble: 'Preamble line.', purpose: 'Fix the DNS drift', diagnosis: d, fix: { index: 0, title: d.result!.fixes[0].title, detail: d.result!.fixes[0].detail } });
    expect(brief.startsWith('Preamble line.')).toBe(true);
    expect(brief).toContain('Fix the DNS drift');
    expect(brief).toContain('DNS records drift from the rules.');
    expect(brief).toContain('e1 (dns_placement_status): One host drifts.');
    expect(brief).toContain('Apply the DNS placement plan');
    expect(brief).toContain('"applyMode": "propose-only"');
    expect(brief).toContain('"ip": "192.0.2.1"');
  });

  it('leaves the plan out of a fix that is not about DNS', () => {
    const d = diagnosis();
    const brief = buildBrief({ preamble: '', purpose: 'Restart', diagnosis: d, fix: { index: 1, title: 'Restart the pod', detail: 'Restart the web pod.' } });
    expect(brief).not.toContain('propose-only data');
    expect(fixCitesPlan({ title: 'Restart the pod' }, d)).toBe(false);
    expect(fixCitesPlan({ title: 'Move records', detail: 'see dns_placement_plan' }, d)).toBe(true);
  });

  it('masks secrets', () => {
    const brief = buildBrief({ preamble: '', purpose: `Use token ${FAKE_SECRET} now` });
    expect(brief).not.toContain(FAKE_SECRET);
  });
});

describe('approval gate', () => {
  it('creates a pending request and starts nothing without approval', async () => {
    const s = service();
    const l = s.create({ purpose: 'Fix the DNS drift', diagnosisId: 'd1', fix: { index: 0, title: 'Apply the DNS placement plan' } }, 'alice');
    expect(l.status).toBe('pending_approval');
    expect(l.requestedBy).toBe('alice');
    expect(l.brief).toContain('"applyMode": "propose-only"');
    await new Promise(r => setTimeout(r, 40));
    expect(fake.connections).toBe(0);
    expect(fake.frames).toEqual([]);
    expect(fake.requests).toEqual([]);
    expect(s.tracking).toBe(0);
  });

  it('launches on approve with the owner-rule payload and tracks the thread', async () => {
    const s = service();
    const l = s.create({ purpose: 'Fix the DNS drift', diagnosisId: 'd1' }, 'alice');
    const approved = await s.approve(l.id, 'bob');
    expect(approved.status).toBe('running');
    expect(approved.decidedBy).toBe('bob');
    expect(approved.threadId).toBeTruthy();
    expect(approved.threadLink).toBe(`https://t3.example.com/thread/${approved.threadId}`);
    const req = fake.frames.find(f => f.tag === 'orchestration.launchThread')!.payload as any;
    expect(req).toMatchObject({ projectId: 'project-0', title: 'Incident agent: Fix the DNS drift', generateTitle: false, runtimeMode: 'full-access', interactionMode: 'default', workspaceStrategy: { type: 'root' }, modelSelection: { instanceId: 'provider-0', model: 'model-0' } });
    expect(req.initialMessage.text).toBe(l.brief);
  });

  it('uses the project of the request', async () => {
    const s = service();
    const l = s.create({ purpose: 'x', projectKey: 'other' }, 'a');
    await s.approve(l.id, 'a');
    expect((fake.frames.find(f => f.tag === 'orchestration.launchThread')!.payload as any).projectId).toBe('project-1');
    expect(() => s.create({ purpose: 'x', projectKey: 'nope' }, 'a')).toThrow(/Unknown project/);
  });

  it('rejects a request and never launches it, even when approved later', async () => {
    const s = service();
    const l = s.create({ purpose: 'x' }, 'alice');
    expect(s.reject(l.id, 'bob').status).toBe('rejected');
    await expect(s.approve(l.id, 'bob')).rejects.toMatchObject({ status: 409 });
    expect(fake.connections).toBe(0);
  });

  it('approves only once', async () => {
    const s = service();
    const l = s.create({ purpose: 'x' }, 'a');
    const [a, b] = await Promise.allSettled([s.approve(l.id, 'a'), s.approve(l.id, 'a')]);
    expect([a.status, b.status].sort()).toEqual(['fulfilled', 'rejected']);
    expect(fake.frames.filter(f => f.tag === 'orchestration.launchThread')).toHaveLength(1);
  });

  it('answers 409 above maxRunning and counts only active launches', async () => {
    const s = service(launchConfig({ maxRunning: 1 }));
    const first = await s.approve(s.create({ purpose: 'one' }, 'a').id, 'a');
    const second = s.create({ purpose: 'two' }, 'a');
    await expect(s.approve(second.id, 'a')).rejects.toMatchObject({ status: 409 });
    expect(launchStore.get(second.id)!.status).toBe('pending_approval');
    // The first one ends: the second may start.
    fake.threads.get(first.threadId!)!.projection.runs = [run('r1', 'completed', { completedAt: '2026-11-20T07:01:00.000Z' })];
    await until(() => launchStore.get(first.id)!.status === 'completed');
    expect((await s.approve(second.id, 'a')).status).toBe('running');
  });

  it('records a failed launch with the reason and keeps it out of the active count', async () => {
    const s = service();
    fake.rpcDie = 'Expected launchThread';
    const l = await s.approve(s.create({ purpose: 'x' }, 'a').id, 'a');
    expect(l.status).toBe('failed');
    expect(l.error).toContain('Expected launchThread');
    expect(launchStore.active()).toHaveLength(0);
  });
});

describe('tracking', () => {
  it('maps running, waiting and completed, sets the reply and stops polling when final', async () => {
    const s = service();
    const l = await s.approve(s.create({ purpose: 'x' }, 'a').id, 'a');
    const t = fake.threads.get(l.threadId!)!.projection;
    t.runs = [run('r1', 'running')];
    t.turnItems = [{ id: 'i1', runId: 'r1', ordinal: 1, type: 'command_execution', status: 'running', title: 'echo hi', input: 'echo hi', startedAt: '2026-11-20T07:00:02.000Z' }];
    await until(() => launchStore.get(l.id)!.timeline.some(e => e.kind === 'tool'));
    expect(launchStore.get(l.id)!.status).toBe('running');
    t.runs = [run('r1', 'waiting')];
    await until(() => launchStore.get(l.id)!.status === 'waiting');
    // Waiting is not final: tracking goes on.
    expect(s.tracking).toBe(1);
    t.messages.push({ id: 'm2', role: 'assistant', text: 'DONE', streaming: false, createdAt: '2026-11-20T07:00:08.000Z', runId: 'r1' });
    t.runs = [run('r1', 'completed', { completedAt: '2026-11-20T07:00:09.000Z' })];
    await until(() => launchStore.get(l.id)!.status === 'completed');
    const done = launchStore.get(l.id)!;
    expect(done.lastReply).toBe('DONE');
    expect(done.finishedAt).toBe('2026-11-20T07:00:09.000Z');
    await until(() => s.tracking === 0);
  });

  it('marks failed with the error of the run', async () => {
    const s = service();
    const l = await s.approve(s.create({ purpose: 'x' }, 'a').id, 'a');
    const t = fake.threads.get(l.threadId!)!.projection;
    t.runs = [run('r1', 'failed')];
    t.turnItems = [{ id: 'i1', runId: 'r1', ordinal: 1, type: 'error', status: 'completed', failure: 'The model quota is used up' }];
    await until(() => launchStore.get(l.id)!.status === 'failed');
    expect(launchStore.get(l.id)!.error).toBe('The model quota is used up');
  });

  it('backs off on errors and marks failed after repeated errors with the reason', async () => {
    const s = service();
    const l = await s.approve(s.create({ purpose: 'x' }, 'a').id, 'a');
    fake.readStatus = 500;
    await until(() => launchStore.get(l.id)!.status === 'failed');
    expect(launchStore.get(l.id)!.error).toMatch(/Tracking stopped after 3 errors in a row/);
    expect(s.tracking).toBe(0);
  });

  it('recovers from a short error without failing', async () => {
    const s = service();
    const l = await s.approve(s.create({ purpose: 'x' }, 'a').id, 'a');
    fake.readStatus = 500;
    await new Promise(r => setTimeout(r, 15));
    fake.readStatus = undefined;
    fake.threads.get(l.threadId!)!.projection.runs = [run('r1', 'completed', { completedAt: '2026-11-20T07:01:00.000Z' })];
    await until(() => launchStore.get(l.id)!.status === 'completed');
  });

  it('marks failed when T3 no longer has the thread', async () => {
    const s = service();
    const l = await s.approve(s.create({ purpose: 'x' }, 'a').id, 'a');
    fake.threads.delete(l.threadId!);
    await until(() => launchStore.get(l.id)!.status === 'failed');
    expect(launchStore.get(l.id)!.error).toMatch(/no longer has this thread/);
  });
});

describe('follow-up messages', () => {
  it('dispatches the message and tracks the new run after a completed one', async () => {
    const s = service();
    const l = await s.approve(s.create({ purpose: 'x' }, 'a').id, 'a');
    const t = fake.threads.get(l.threadId!)!.projection;
    t.runs = [run('r1', 'completed', { completedAt: '2026-11-20T07:01:00.000Z' })];
    await until(() => launchStore.get(l.id)!.status === 'completed');
    const sent = await s.message(l.id, 'Check it again.');
    expect(sent.status).toBe('running');
    const frame = fake.frames.filter(f => f.tag === 'orchestration.dispatchCommand').at(-1)!.payload as any;
    expect(frame).toMatchObject({ type: 'message.dispatch', text: 'Check it again.', dispatchMode: { type: 'start_immediately' } });
    // The fake created run 2 (running). It completes.
    await until(() => t.runs.length === 2);
    t.runs[1] = run('r2', 'completed', { completedAt: '2026-11-20T07:12:00.000Z' });
    await until(() => launchStore.get(l.id)!.status === 'completed' && launchStore.get(l.id)!.timeline.filter(e => e.kind === 'run').length === 2);
  });

  it('queues the message while a run is active', async () => {
    const s = service();
    const l = await s.approve(s.create({ purpose: 'x' }, 'a').id, 'a');
    await s.message(l.id, 'More.');
    const frame = fake.frames.filter(f => f.tag === 'orchestration.dispatchCommand').at(-1)!.payload as any;
    expect(frame.dispatchMode).toEqual({ type: 'queue_after_active' });
  });

  it('refuses a message for a request that has no thread', async () => {
    const s = service();
    const l = s.create({ purpose: 'x' }, 'a');
    await expect(s.message(l.id, 'hi')).rejects.toMatchObject({ status: 409 });
    expect(fake.frames).toEqual([]);
  });
});

describe('restart', () => {
  it('resumes tracking of a running launch and fails one that was still launching', async () => {
    const s1 = service();
    const l = await s1.approve(s1.create({ purpose: 'x' }, 'a').id, 'a');
    s1.shutdown();
    // A launch that a restart interrupted before T3 answered.
    const stuck: Launch = { ...launchStore.get(l.id)!, id: 'stuck', status: 'launching', threadId: undefined };
    launchStore.put(stuck);
    // A new process reads the files.
    const reloaded = new LaunchStore(dir, 200);
    expect(reloaded.get(l.id)!.status).toBe('running');
    const s2 = service(launchConfig(), reloaded);
    s2.resume();
    expect(reloaded.get('stuck')!.status).toBe('failed');
    expect(reloaded.get('stuck')!.error).toMatch(/interrupted by restart/);
    fake.threads.get(l.threadId!)!.projection.runs = [run('r1', 'completed', { completedAt: '2026-11-20T07:01:00.000Z' })];
    await until(() => reloaded.get(l.id)!.status === 'completed');
  });

  it('keeps one JSON file per launch and at most the cap', () => {
    const store = new LaunchStore(dir, 3);
    const s = service(launchConfig(), store);
    for (let i = 0; i < 5; i++) {
      const l = s.create({ purpose: `p${i}` }, 'a');
      s.reject(l.id, 'a');
    }
    expect(store.list()).toHaveLength(3);
    expect(readdirSync(join(dir, 'launches')).filter(f => f.endsWith('.json'))).toHaveLength(3);
  });

  it('never drops a pending or active launch to stay under the cap', () => {
    const store = new LaunchStore('', 1);
    const s = service(launchConfig(), store);
    s.create({ purpose: 'a' }, 'a');
    s.create({ purpose: 'b' }, 'a');
    expect(store.list()).toHaveLength(2);
  });
});

describe('masking', () => {
  it('masks secrets in the stored file, the brief, the timeline and the reply', async () => {
    const s = service();
    const l = await s.approve(s.create({ purpose: 'x', brief: `Use ${FAKE_SECRET} please` }, 'a').id, 'a');
    const t = fake.threads.get(l.threadId!)!.projection;
    t.runs = [run('r1', 'completed', { completedAt: '2026-11-20T07:01:00.000Z' })];
    t.messages.push({ id: 'm', role: 'assistant', text: `The key is ${FAKE_SECRET}`, streaming: false, createdAt: '2026-11-20T07:00:08.000Z', runId: 'r1' });
    t.turnItems = [{ id: 'i1', runId: 'r1', ordinal: 1, type: 'command_execution', status: 'completed', input: `curl -H "Authorization: Bearer ${FAKE_SECRET}" x`, output: `token=${FAKE_SECRET}`, exitCode: 0, startedAt: '2026-11-20T07:00:02.000Z' }];
    await until(() => launchStore.get(l.id)!.status === 'completed');
    const file = readFileSync(join(dir, 'launches', `${l.id}.json`), 'utf8');
    expect(file).not.toContain(FAKE_SECRET);
    expect(JSON.stringify(launchStore.get(l.id))).not.toContain(FAKE_SECRET);
  });
});

describe('timeline mapping', () => {
  it('maps runs, messages, tools and file changes, and hides the workspace step', () => {
    const f = JSON.parse(readFileSync(new URL('./fixtures/t3/thread-projection.json', import.meta.url), 'utf8')) as { projection: any };
    const t = mapProjection(f.projection);
    expect(t.status).toBe('completed');
    expect(t.final).toBe(true);
    expect(t.lastReply).toBe('DONE');
    expect(t.timeline.map(e => `${e.kind}:${e.title}:${e.status}`)).toEqual([
      'run:Run 1:done',
      'message:Operator message:done',
      // The step still says running, but its run is completed: it ended with the run.
      'tool:echo probe-ok:done',
      'file_change:notes.txt:done',
      'message:Agent reply:done',
    ]);
    expect(t.timeline.find(e => e.kind === 'file_change')!.detail).toContain('+3 -1');
  });

  it('is not completed while a run is active or a reply streams', () => {
    const f = JSON.parse(readFileSync(new URL('./fixtures/t3/thread-projection.json', import.meta.url), 'utf8')) as { projection: any };
    f.projection.runs.push(run('r2', 'running'));
    expect(mapProjection(f.projection)).toMatchObject({ status: 'running', final: false });
    f.projection.runs.pop();
    f.projection.messages[1].streaming = true;
    expect(mapProjection(f.projection)).toMatchObject({ status: 'running', final: false });
  });

  it('maps a pending runtime request to waiting, and cancelled, failed and interrupted to final states', () => {
    const base = (status: string, extra: Record<string, unknown> = {}) => ({ thread: { id: 't' }, runs: [run('r1', status)], messages: [], turnItems: [], runtimeRequests: [], ...extra });
    expect(mapProjection(base('running', { runtimeRequests: [{ status: 'pending', kind: 'command' }] }) as any).status).toBe('waiting');
    expect(mapProjection(base('cancelled') as any)).toMatchObject({ status: 'cancelled', final: true });
    expect(mapProjection(base('interrupted') as any)).toMatchObject({ status: 'failed', final: true });
    expect(mapProjection(base('waiting') as any)).toMatchObject({ status: 'waiting', final: false });
    expect(mapProjection({ ...base('running'), runs: [] } as any)).toMatchObject({ status: 'running', final: false });
  });
});

describe('HTTP API', () => {
  async function api(configure: (c: LaunchConfig) => LaunchConfig = c => c) {
    const base = loadConfig({} as NodeJS.ProcessEnv);
    const config = { ...base, port: 0, host: '127.0.0.1', kubeApi: 'http://127.0.0.1:1', kubeTokenFile: '/nonexistent', dataDir: dir, launch: configure(launchConfig()) };
    const server = await startServer(config);
    const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
      const res = await fetch(`http://127.0.0.1:${server.port}${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, body: (await res.json().catch(() => null)) as any };
    };
    return { server, call };
  }

  it('answers 503 with a reason when launching is off, and the config says so', async () => {
    const { server, call } = await api(c => ({ ...c, t3Url: '' }));
    try {
      expect(await call('GET', '/api/launches/config')).toMatchObject({ status: 200, body: { enabled: false, reason: 'T3_URL is not set' } });
      const r = await call('POST', '/api/launches', { purpose: 'x' });
      expect(r.status).toBe(503);
      expect(r.body.error).toContain('T3_URL is not set');
    } finally {
      await server.close();
    }
  });

  it('runs request, approve, tracking, message and list over HTTP', async () => {
    const { server, call } = await api();
    try {
      const created = await call('POST', '/api/launches', { purpose: 'Fix DNS', projectKey: 'default' }, { 'x-remote-user': 'alice' });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({ status: 'pending_approval', requestedBy: 'alice' });
      const id = created.body.id as string;
      expect(fake.connections).toBe(0);
      expect((await call('GET', `/api/launches/${id}`)).body.status).toBe('pending_approval');
      const approved = await call('POST', `/api/launches/${id}/approve`, {}, { 'x-remote-user': 'bob' });
      expect(approved.status).toBe(200);
      expect(approved.body).toMatchObject({ status: 'running', decidedBy: 'bob' });
      const msg = await call('POST', `/api/launches/${id}/messages`, { text: 'Go on.' });
      expect(msg.status).toBe(202);
      const list = await call('GET', '/api/launches?limit=10');
      expect(list.body.launches).toHaveLength(1);
      expect(list.body.launches[0]).not.toHaveProperty('brief');
      expect(list.body.launches[0].steps).toBeTypeOf('number');
      expect((await call('POST', `/api/launches/${id}/approve`, {})).status).toBe(409);
      expect((await call('GET', '/api/launches/unknown')).status).toBe(404);
      expect((await call('POST', '/api/launches', { purpose: '' })).status).toBe(400);
      expect((await call('POST', '/api/launches', { purpose: 'x', diagnosisId: 'missing' })).status).toBe(404);
    } finally {
      await server.close();
    }
  });

  it('serves the preview brief without creating a launch', async () => {
    const { server, call } = await api();
    try {
      const r = await call('POST', '/api/launches/preview', { purpose: 'Fix DNS' });
      expect(r.status).toBe(200);
      expect(r.body.brief).toContain('You work for the operators of this cluster.');
      expect((await call('GET', '/api/launches')).body.launches).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  it('rejects over HTTP', async () => {
    const { server, call } = await api();
    try {
      const id = (await call('POST', '/api/launches', { purpose: 'x' })).body.id as string;
      expect((await call('POST', `/api/launches/${id}/reject`, {})).body.status).toBe('rejected');
      expect(fake.connections).toBe(0);
    } finally {
      await server.close();
    }
  });
});

describe('list_agent_launches tool', () => {
  it('lists launches read-only, and the model tool set does not include it', async () => {
    const s = service();
    s.create({ purpose: 'Fix DNS', diagnosisId: 'd1' }, 'alice');
    const runtime = new Runtime({ ...loadConfig({} as NodeJS.ProcessEnv), kubeApi: 'http://127.0.0.1:1' }, diagnoses, launchStore);
    const out = await runtime.registry.call('list_agent_launches', { status: 'pending_approval' }, p => runtime.context(p));
    expect(out.ok).toBe(true);
    expect((out.data as any).launches).toHaveLength(1);
    expect((out.data as any).launches[0]).toMatchObject({ purpose: 'Fix DNS', status: 'pending_approval', diagnosisId: 'd1' });
    expect(runtime.registry.providers.map(p => p.name)).toContain('launches');
    const names = (await runtime.toolHost().list()).map(t => t.name);
    expect(names).not.toContain('list_agent_launches');
  });
});
