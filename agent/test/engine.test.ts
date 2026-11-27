import { describe, expect, it } from 'vitest';
import { diagnose, evidencePlan, type ToolHost } from '../src/agent/engine.js';
import type { Completion, CompleteRequest, ModelClient } from '../src/agent/model.js';

const FAKE_TOKEN = ['abc', '123'].join('');

const alert = {
  name: 'KubePodCrashLooping',
  severity: 'warning',
  labels: { alertname: 'KubePodCrashLooping', namespace: 'shop', pod: 'web-1' },
  annotations: {},
  startsAt: '2026-11-18T05:00:00Z',
  fingerprint: 'f',
};

function host(calls: string[]): ToolHost {
  const names = ['list_alert_rules', 'get_resource', 'get_pod_logs', 'list_events', 'query_metrics_range'];
  return {
    list: async () => names.map(name => ({ name, description: name, parameters: { type: 'object', properties: {} } })),
    call: async (name, args) => {
      calls.push(name);
      return { ok: true, summary: `${name} ok`, data: { args, note: `token=${FAKE_TOKEN}` } };
    },
  };
}

/** A scripted model: asks for two tools per turn until forced to submit, then cites e2 and an invented id. */
function model(requests: CompleteRequest[]): ModelClient {
  return {
    name: 'scripted',
    async complete(req: CompleteRequest): Promise<Completion> {
      requests.push(req);
      if (req.forceTool === 'submit_diagnosis') {
        return {
          text: '',
          stop: 'tool_use',
          usage: { input: 0, output: 0 },
          toolCalls: [
            {
              id: 's',
              name: 'submit_diagnosis',
              args: {
                summary: 'OOM.',
                likelyCause: 'Memory limit too low.',
                confidence: 'medium',
                signals: [{ text: 'OOMKilled', evidence: ['e2', 'nope'] }],
                fixes: [{ title: 'Raise limit', detail: 'In Git.' }],
                verify: 'No restarts.',
              },
            },
          ],
        };
      }
      return {
        text: 'Looking at memory.',
        stop: 'tool_use',
        usage: { input: 0, output: 0 },
        toolCalls: [
          { id: `c${requests.length}`, name: 'query_metrics_range', args: { reason: 'Memory trend?', query: 'x' } },
          { id: `d${requests.length}`, name: 'query_metrics_range', args: { reason: 'Again?', query: 'y' } },
        ],
      };
    },
  } as unknown as ModelClient;
}

describe('diagnosis engine', () => {
  it('plans evidence from the alert labels', () => {
    const plan = evidencePlan(alert, new Set(['list_alert_rules', 'get_resource', 'get_pod_logs', 'list_events']));
    expect(plan.map(p => p.tool)).toEqual(['list_alert_rules', 'get_resource', 'get_pod_logs', 'list_events']);
  });

  it('has no tool cap: it runs every call the model asks for, forces the submit near the time limit and checks evidence ids', async () => {
    const calls: string[] = [];
    const requests: CompleteRequest[] = [];
    const slow: ToolHost = { ...host(calls), call: async (name, args) => { await new Promise(r => setTimeout(r, 25)); return host(calls).call(name, args); } };
    const d = await diagnose({ alert, tools: slow, model: model(requests), timeoutMs: 600, source: 'api' });
    expect(d.status).toBe('done');
    // The scripted model asks for two tools a turn and submits only when forced: far more than the old cap of ten.
    expect(d.toolCalls).toBeGreaterThan(4);
    expect(calls.filter(c => c === 'query_metrics_range')).toHaveLength(d.toolCalls);
    expect(requests.at(-1)?.forceTool).toBe('submit_diagnosis');
    expect(requests.at(-1)?.tools.map(t => t.name)).toEqual(['submit_diagnosis']);
    expect(requests.slice(0, -1).every(r => !r.forceTool)).toBe(true);
    expect(d.result?.signals[0].evidence).toEqual(['e2']);
    expect(d.evidence.slice(0, 4).map(e => e.id)).toEqual(['e1', 'e2', 'e3', 'e4']);
    expect(d.toolBudget).toBeUndefined();
    expect(JSON.stringify(requests)).not.toContain(FAKE_TOKEN);
    expect(requests[0].tools.find(t => t.name === 'get_resource')?.parameters.required).toContain('reason');
    expect(d.a2ui[0]).toHaveProperty('createSurface');
    expect(JSON.stringify(d.a2ui)).not.toMatch(/\d+\/\d+ tool calls/);
  });

  it('fails at the time limit when the model never submits', async () => {
    const never = { name: 'x', complete: async (req: CompleteRequest) => { await new Promise((_, reject) => req.signal?.addEventListener('abort', () => reject(new Error('cancelled')))); return undefined as never; } } as unknown as ModelClient;
    const d = await diagnose({ alert, tools: host([]), model: never, timeoutMs: 80, source: 'api' });
    expect(d.status).toBe('failed');
    expect(d.error).toBe('The diagnosis took longer than 0 seconds.'.replace('0 seconds', '1 second'));
  });

  it('fails cleanly when the model errors', async () => {
    const broken = {
      name: 'x',
      complete: async () => {
        throw new Error('Model endpoint answered 401');
      },
    } as unknown as ModelClient;
    const d = await diagnose({ alert, tools: host([]), model: broken, source: 'api' });
    expect(d.status).toBe('failed');
    expect(d.error).toMatch(/401/);
    expect(d.a2ui[0]).toHaveProperty('createSurface');
  });

  it('fails with a clear error when the forced final turn returns no submit_diagnosis', async () => {
    const mute = { name: 'x', complete: async () => ({ text: 'No.', stop: 'end', usage: { input: 0, output: 0 }, toolCalls: [] }) } as unknown as ModelClient;
    const d = await diagnose({ alert, tools: host([]), model: mute, source: 'api' });
    expect(d.status).toBe('failed');
    expect(d.error).toBe('The model did not submit a diagnosis');
  });

  it('keeps the full data of the DNS plan in its evidence item, masked, and no other tool data', async () => {
    const dnsAlert = { ...alert, name: 'DnsPlacementDrift', labels: { alertname: 'DnsPlacementDrift', host: 'app.example.com' } };
    const tools: ToolHost = {
      list: async () => ['dns_placement_status', 'dns_placement_plan', 'list_events'].map(name => ({ name, description: name, parameters: { type: 'object', properties: {} } })),
      call: async name => ({ ok: true, summary: `${name} ok`, data: { changes: [{ host: 'app.example.com', note: `token=${FAKE_TOKEN}` }] } }),
    };
    const d = await diagnose({ alert: dnsAlert, tools, model: model([]), timeoutMs: 400, source: 'api' });
    const plan = d.evidence.find(e => e.tool === 'dns_placement_plan');
    expect(plan?.data).toMatchObject({ changes: [{ host: 'app.example.com' }] });
    expect(JSON.stringify(plan?.data)).not.toContain(FAKE_TOKEN);
    expect(d.evidence.filter(e => e.tool !== 'dns_placement_plan').every(e => e.data === undefined)).toBe(true);
  });
});
