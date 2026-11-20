import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { T3Client, T3Error } from '../src/t3/client.js';
import { startFakeT3, sampleThread, type FakeT3 } from './helpers/fake-t3.js';

/**
 * Contract test. The fixtures in test/fixtures/t3 hold the exact frames of the T3 protocol
 * as SPEC.md of the protocol probe records them (ids and names replaced). The client must
 * send exactly these. When T3 changes the protocol, update the fixtures and the client together.
 */
const fixture = <T = Record<string, unknown>>(name: string): T => JSON.parse(readFileSync(new URL(`./fixtures/t3/${name}`, import.meta.url), 'utf8')) as T;

let fake: FakeT3;
let n: number;
const client = () => new T3Client({ url: fake.url, readToken: () => fake.token, newId: () => `id-${++n}` });

beforeEach(async () => {
  fake = await startFakeT3();
  n = 0;
});
afterEach(async () => {
  await fake.close();
});

describe('T3 protocol contract', () => {
  it('sends the launchThread frame exactly', async () => {
    await client().launchThread({ threadId: 'thread-0', projectId: 'project-0', title: 'Incident agent: probe', modelSelection: { instanceId: 'provider-0', model: 'model-0' }, text: 'Reply with the single word OK and do nothing else.' });
    expect(fake.frames.filter(f => f._tag === 'Request')).toEqual([fixture('launch-request.json')]);
  });

  it('sends the message.dispatch frame as a bare command', async () => {
    fake.threads.set('thread-0', sampleThread('thread-0'));
    await client().sendMessage('thread-0', 'Check it again.');
    expect(fake.frames.filter(f => f._tag === 'Request')).toEqual([fixture('message-dispatch-request.json')]);
  });

  it('opens the WebSocket with the protocol and capability parameters', async () => {
    await client().launchThread({ threadId: 'thread-0', projectId: 'project-0', title: 't', modelSelection: { instanceId: 'a', model: 'b' }, text: 'x' });
    expect(fake.upgrades).toEqual([fixture<{ upgrade: string }>('websocket-upgrade.json').upgrade]);
  });

  it('answers a server Ping with a Pong frame', async () => {
    const c = await client().rpc();
    await new Promise(r => setTimeout(r, 60));
    c.close();
    expect(fake.frames.filter(f => f._tag === 'Pong')).toEqual([fixture('pong.json')]);
  });

  it('sends the bearer token, and the protocol header on orchestration reads only', async () => {
    fake.threads.set('thread-0', sampleThread('thread-0', { runs: [{ id: 'r', status: 'running' }] }));
    const c = client();
    await c.thread('thread-0');
    await c.launchThread({ threadId: 'thread-1', projectId: 'p', title: 't', modelSelection: { instanceId: 'a', model: 'b' }, text: 'x' });
    const want = fixture<Record<string, { method: string; path: string; authorization: string; protocolHeader: string | null }>>('http-headers.json');
    const seen = (path: string) => fake.requests.find(r => r.path === path)!;
    for (const key of ['ticket', 'thread'] as const) {
      const w = want[key];
      const r = seen(w.path);
      expect({ method: r.method, path: r.path, authorization: r.headers.authorization, protocolHeader: (r.headers['x-t3-orchestration-protocol'] as string | undefined) ?? null }).toEqual({ ...w, authorization: `Bearer ${fake.token}` });
    }
  });

  it('reads the thread projection shape of the fixture', async () => {
    const f = fixture<{ projection: any }>('thread-projection.json');
    fake.threads.set('thread-0', { projection: f.projection });
    const snap = await client().thread('thread-0');
    expect(snap.projection.runs[0].status).toBe('completed');
    expect(snap.projection.messages.map(m => m.role)).toEqual(['user', 'assistant']);
    expect(snap.projection.turnItems).toHaveLength(4);
  });

  it('reports a Die defect as a permanent T3Error with the defect text', async () => {
    fake.rpcDie = 'Expected { readonly "type": "thread.stop" } | ...';
    const err = await client().launchThread({ threadId: 't', projectId: 'p', title: 't', modelSelection: { instanceId: 'a', model: 'b' }, text: 'x' }).catch(e => e);
    expect(err).toBeInstanceOf(T3Error);
    expect(err.transient).toBe(false);
    expect(err.message).toContain('Expected');
  });

  it('turns a 401 into a T3Error and never prints the token', async () => {
    const bad = new T3Client({ url: fake.url, readToken: () => 'wrong-token-value' });
    const err = await bad.thread('thread-0').catch(e => e);
    expect(err).toBeInstanceOf(T3Error);
    expect(err.status).toBe(401);
    expect(err.message).not.toContain('wrong-token-value');
  });

  it('reads the token file on each call, so rotation needs no restart', async () => {
    let current = 'wrong-token-value';
    const rotating = new T3Client({ url: fake.url, readToken: () => current });
    fake.threads.set('thread-0', sampleThread('thread-0', { runs: [{ id: 'r', status: 'running' }] }));
    await expect(rotating.thread('thread-0')).rejects.toThrow(/401/);
    current = fake.token;
    await expect(rotating.thread('thread-0')).resolves.toBeTruthy();
  });
});
