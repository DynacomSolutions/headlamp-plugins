import { describe, expect, it } from 'vitest';
import { alertFromPrompt, userText } from '../src/acp.js';

const T3 = `<t3_code_instructions>
## T3 Code interaction mode: Default
Run with ELECTRON_RUN_AS_NODE=1 and mode=auto. Example: {"not": "an alert"}
</t3_code_instructions>`;

describe('ACP prompt parsing', () => {
  it('drops host instruction blocks before or after the message', () => {
    expect(userText(`${T3}\nSmartSectorsFailing node=eu4`)).toBe('SmartSectorsFailing node=eu4');
    expect(userText(`SmartSectorsFailing node=eu4\n\n${T3}`)).toBe('SmartSectorsFailing node=eu4');
    expect(userText('KubePodCrashLooping <system-reminder>x=1')).toBe('KubePodCrashLooping');
  });

  it('uses only the marked request when the host wraps it (T3 Code wire format)', () => {
    const blocks = [
      `${T3}\n\n<user_request>\nSmartSectorsFailing severity=warning node=eu4 device=sdj\n</user_request>`,
      '<runtime_info>You are running in T3 Code.</runtime_info>\n\n<pull_request_linking>\nUse acp-mcp-call delegate_task \'{"task":"..."}\'\n</pull_request_linking>',
    ].join('\n');
    expect(userText(blocks)).toBe('SmartSectorsFailing severity=warning node=eu4 device=sdj');
    const alert = alertFromPrompt(blocks);
    expect(alert?.name).toBe('SmartSectorsFailing');
    expect(alert?.labels).toEqual({ alertname: 'SmartSectorsFailing', severity: 'warning', node: 'eu4', device: 'sdj' });
  });

  it('drops every whole tagged block when the request is not marked', () => {
    expect(userText('<runtime_info>x {"a":1}</runtime_info>\nNodeNotReady node=w1')).toBe('NodeNotReady node=w1');
  });

  it('parses the alert from the user text only', () => {
    const alert = alertFromPrompt(`SmartSectorsFailing severity=warning node=eu4 device=sdj\n\n${T3}`);
    expect(alert?.name).toBe('SmartSectorsFailing');
    expect(alert?.labels).toEqual({ alertname: 'SmartSectorsFailing', severity: 'warning', node: 'eu4', device: 'sdj' });
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
