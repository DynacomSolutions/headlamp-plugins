import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { renderDiagnosis, type Diagnosis } from '../src/agent/report.js';
import { summaryViewData, summaryViewTemplate } from '../src/a2ui/index.js';

const load = (name: string) => JSON.parse(readFileSync(new URL(`./a2ui-v1/${name}`, import.meta.url), 'utf8'));

function validator() {
  const ajv = new (Ajv2020 as unknown as typeof Ajv2020.default)({ strict: false, allErrors: true });
  ajv.addSchema(load('common_types.json'));
  // The A2UI test harness serves the chosen catalog as catalog.json next to the protocol schema.
  ajv.addSchema({ ...load('basic_catalog.json'), $id: 'https://a2ui.org/specification/v1_0/catalog.json' });
  return ajv.compile(load('agent_to_renderer.json'));
}

const diagnosis: Diagnosis = {
  id: '6f1c2d3e-0000-4000-8000-000000000001',
  createdAt: '2026-11-18T05:00:00Z',
  status: 'done',
  source: 'webhook',
  alert: { name: 'KubePodCrashLooping', severity: 'warning', labels: { alertname: 'KubePodCrashLooping', namespace: 'shop', pod: 'web-1' }, annotations: { summary: 'web-1 restarts' }, startsAt: '2026-11-18T04:50:00Z', fingerprint: 'abc' },
  result: {
    summary: 'The web container runs out of memory under load.',
    likelyCause: 'The memory limit of 256 MiB is too low.',
    confidence: 'high',
    signals: [{ text: 'Last state OOMKilled', evidence: ['e1'], holds: true }],
    fixes: [{ title: 'Raise the limit', detail: 'Raise memory to 512 MiB in Git.', command: 'kubectl describe pod web-1 -n shop', recommended: true }],
    verify: 'No restarts for 30 minutes.',
  },
  evidence: [{ id: 'e1', tool: 'get_resource', reason: 'Pod state?', summary: 'Pod web-1: CrashLoopBackOff', ok: true }],
  toolCalls: 3,
  toolBudget: 10,
  model: 'test-model',
  a2ui: [],
};

describe('A2UI v1.0 conformance (official JSON Schemas, basic catalog)', () => {
  const validate = validator();
  it('diagnosis surface is valid', () => {
    for (const message of renderDiagnosis(diagnosis)) expect(validate(message), JSON.stringify(validate.errors)).toBe(true);
  });
  it('failed and running surfaces are valid', () => {
    for (const d of [{ ...diagnosis, status: 'failed' as const, result: undefined, error: 'boom' }, { ...diagnosis, status: 'running' as const, result: undefined }]) {
      for (const message of renderDiagnosis(d)) expect(validate(message), JSON.stringify(validate.errors)).toBe(true);
    }
  });
  it('summary view template and data update are valid', () => {
    for (const message of [...summaryViewTemplate(), summaryViewData({ title: 'T', summary: 'S', rows: [{ label: 'a', detail: 'b' }] })]) {
      expect(validate(message), JSON.stringify(validate.errors)).toBe(true);
    }
  });
  it('component ids are unique and there is one root', () => {
    const create = renderDiagnosis(diagnosis)[0] as { createSurface: { components: Array<{ id: string }> } };
    const ids = create.createSurface.components.map(c => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter(id => id === 'root')).toHaveLength(1);
  });
});
