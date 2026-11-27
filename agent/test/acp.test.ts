import { afterEach, describe, expect, it, vi } from 'vitest';
import { alertFromPrompt, publish, userText } from '../src/acp.js';
import type { Diagnosis } from '../src/agent/report.js';

const T3 = `<t3_code_instructions>
## T3 Code interaction mode: Default
Run with ELECTRON_RUN_AS_NODE=1 and mode=auto. Example: {"not": "an alert"}
</t3_code_instructions>`;

describe('ACP prompt parsing', () => {
  it('drops host instruction blocks before or after the message', () => {
    expect(userText(`${T3}\nSmartSectorsFailing node=w2`)).toBe('SmartSectorsFailing node=w2');
    expect(userText(`SmartSectorsFailing node=w2\n\n${T3}`)).toBe('SmartSectorsFailing node=w2');
    expect(userText('KubePodCrashLooping <system-reminder>x=1')).toBe('KubePodCrashLooping');
  });

  it('uses only the marked request when the host wraps it (T3 Code wire format)', () => {
    const blocks = [
      `${T3}\n\n<user_request>\nSmartSectorsFailing severity=warning node=w2 device=sdj\n</user_request>`,
      '<runtime_info>You are running in T3 Code.</runtime_info>\n\n<pull_request_linking>\nUse acp-mcp-call delegate_task \'{"task":"..."}\'\n</pull_request_linking>',
    ].join('\n');
    expect(userText(blocks)).toBe('SmartSectorsFailing severity=warning node=w2 device=sdj');
    const alert = alertFromPrompt(blocks);
    expect(alert?.name).toBe('SmartSectorsFailing');
    expect(alert?.labels).toEqual({ alertname: 'SmartSectorsFailing', severity: 'warning', node: 'w2', device: 'sdj' });
  });

  it('drops every whole tagged block when the request is not marked', () => {
    expect(userText('<runtime_info>x {"a":1}</runtime_info>\nNodeNotReady node=w1')).toBe('NodeNotReady node=w1');
  });

  it('parses the alert from the user text only', () => {
    const alert = alertFromPrompt(`SmartSectorsFailing severity=warning node=w2 device=sdj\n\n${T3}`);
    expect(alert?.name).toBe('SmartSectorsFailing');
    expect(alert?.labels).toEqual({ alertname: 'SmartSectorsFailing', severity: 'warning', node: 'w2', device: 'sdj' });
    expect(alert?.annotations.description).not.toContain('T3 Code');
  });

  it('reads labels from the first line only', () => {
    const alert = alertFromPrompt('NodeNotReady node=w1\nIt started after mode=maintenance was set');
    expect(alert?.labels).toEqual({ alertname: 'NodeNotReady', node: 'w1' });
    expect(alert?.annotations.description).toContain('mode=maintenance');
  });

  it('still accepts a JSON alert and the bare diagnose command next to host instructions', () => {
    const json = JSON.stringify([{ labels: { alertname: 'X', severity: 'critical', pod: 'p' }, startsAt: '2026-11-18T00:00:00Z' }]);
    expect(alertFromPrompt(`${T3}\n${json}`)?.labels.pod).toBe('p');
    expect(alertFromPrompt(`${T3}\ndiagnose`)).toBeUndefined();
  });
});

describe('ACP stdio publish', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('cuts a long run to the limits of the publish schema before it posts', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'abc' }), { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    const evidence = Array.from({ length: 80 }, (_, i) => ({ id: `t${i}`, tool: 'x', reason: 'r', summary: 'y'.repeat(5000), ok: true }));
    const d = { id: '11111111-1111-4111-8111-111111111111', createdAt: '2026-11-28T00:00:00.000Z', status: 'done', source: 'acp', alert: { name: 'A', severity: 'warning', labels: {}, annotations: {}, startsAt: '', fingerprint: '' }, evidence, toolCalls: 2000, model: 'm'.repeat(300), a2ui: [] } as unknown as Diagnosis;
    expect(await publish('http://127.0.0.1:1/mcp', {}, d)).toBe('abc');
    const call = fetchMock.mock.calls[0] as unknown as [string, { body: string }];
    const body = JSON.parse(call[1].body).diagnosis;
    expect(body.evidence).toHaveLength(60);
    expect(body.evidence[0].summary.length).toBeLessThanOrEqual(2000);
    expect(body.toolCalls).toBe(1000);
    expect(body.model.length).toBeLessThanOrEqual(120);
  });
});
