import { describe, expect, it, vi } from 'vitest';

vi.mock('@kinvolk/headlamp-plugin/lib', () => ({ ApiProxy: { request: vi.fn() } }));

import { parseDisplayNames } from './agents';
import { selectionFor } from './detail';
import {
  applyNames,
  humanise,
  idOf,
  nameOf,
  namespaceDataName,
  NO_NAMES,
  stripPodHash,
  uniqueNames,
} from './names';
import { buildNodeTree } from './tree';
import type { NodeMetrics } from './types';

describe('humanise', () => {
  it('drops a common suffix and title-cases', () => {
    expect(humanise('acme-runners')).toBe('Acme');
    expect(humanise('my_cool-operator')).toBe('My Cool');
    expect(humanise('payments-api')).toBe('Payments API');
  });

  it('uses known whole names and casing, and leaves cert-manager as it is', () => {
    expect(humanise('kube-system')).toBe('Kube system');
    expect(humanise('cert-manager')).toBe('cert-manager');
    expect(humanise('victoria-metrics')).toBe('VictoriaMetrics');
    expect(humanise('argocd')).toBe('ArgoCD');
    expect(humanise('cnpg-system')).toBe('CloudNativePG');
    expect(humanise('headlamp')).toBe('Headlamp');
  });

  it('keeps ids that already look deliberate', () => {
    expect(humanise('MyApp')).toBe('MyApp');
    expect(humanise('worker.example.com')).toBe('worker.example.com');
  });
});

describe('stripPodHash', () => {
  it('removes ReplicaSet and random pod suffixes, keeps other names', () => {
    expect(stripPodHash('grafana-7d9f8b6c5d-x2k4p')).toBe('grafana');
    expect(stripPodHash('node-exporter-x7k2p')).toBe('node-exporter');
    expect(stripPodHash('vmstorage-0')).toBe('vmstorage-0');
  });
});

describe('namespaceDataName', () => {
  it('prefers a display-name annotation, then part-of, name and instance labels', () => {
    expect(namespaceDataName({ annotations: { 'app.kubernetes.io/display-name': 'Shop' } })).toBe('Shop');
    expect(namespaceDataName({ labels: { 'app.kubernetes.io/part-of': 'acme' } })).toBe('Acme');
    expect(namespaceDataName({ labels: { 'app.kubernetes.io/name': 'foo-bar' } })).toBe('Foo Bar');
    expect(namespaceDataName({})).toBeUndefined();
  });
});

describe('parseDisplayNames', () => {
  it('reads id=Name lines and skips bad ones', () => {
    expect(parseDisplayNames('a=A\n bad \nb = B C \n=x\nc=')).toEqual({ a: 'A', b: 'B C' });
  });
});

const metrics = (): NodeMetrics => ({
  node: 'worker-1',
  cpuCapacity: 8,
  cpuUsed: 4,
  memCapacity: 8,
  memUsed: 4,
  pods: [
    { namespace: 'acme-runners', pod: 'job-7d9f8b6c5d-x2k4p', container: 'grafana', cpuCores: 1, memBytes: 1 },
  ],
});
const icon = () => '';

describe('names in the tree', () => {
  it('names namespaces, pods and containers, and keeps the raw id as the label', () => {
    const t = buildNodeTree(metrics(), null, 'cpu', icon);
    const ns = t.root.children[0].children[0];
    expect(ns.label).toBe('acme-runners');
    expect(ns.displayName).toBe('Acme');
    expect(ns.children[0].displayName).toBe('Job');
    expect(ns.children[0].children[0].displayName).toBe('Grafana');
  });

  it('prefers the cluster data over the guess, and an override over everything', () => {
    const data = { overrides: {}, namespaces: new Map([['acme-runners', 'Acme CI']]) };
    expect(buildNodeTree(metrics(), null, 'cpu', icon, [], data).root.children[0].children[0].displayName).toBe('Acme CI');
    const forced = { ...data, overrides: { 'acme-runners': 'RW' } };
    expect(buildNodeTree(metrics(), null, 'cpu', icon, [], forced).root.children[0].children[0].displayName).toBe('RW');
  });

  it('names a process from the app table and keeps the command as its id', () => {
    const t = buildNodeTree(
      metrics(),
      {
        node: 'worker-1',
        backend: 'service/a/b:80',
        orchestrators: [],
        units: [
          {
            name: 'x.scope',
            kind: 'scope',
            memBytes: 1,
            cpuCores: 1,
            procs: [{ pid: 1, command: '/usr/bin/node /opt/codex/bin/codex.js', rss: 1, cpuCores: 1, children: [] }],
          },
        ],
      },
      'cpu',
      icon
    );
    const proc = t.root.children.find(c => c.key === 'scope:x.scope')!.children[0];
    expect(proc.displayName).toBe('Codex');
    expect(idOf(proc)).toBe('/usr/bin/node /opt/codex/bin/codex.js');
  });

  it('applyNames with no context leaves T3 and other names alone', () => {
    const t = buildNodeTree(metrics(), null, 'cpu', icon);
    applyNames(t.root, NO_NAMES);
    expect(t.root.displayName).toBeUndefined();
  });
});

describe('the selection carries both names', () => {
  it('gives the friendly name as the label and the raw id apart', () => {
    const t = buildNodeTree(metrics(), null, 'cpu', icon);
    const sel = selectionFor(t, t, [], ['k8s', 'k8s/ns:acme-runners'])!;
    expect(sel.label).toBe('Acme');
    expect(sel.id).toBe('acme-runners');
  });
});

describe('unique sibling names', () => {
  const shared = (ns: string) => ({ namespace: ns, pod: 'p', container: 'c', cpuCores: 1, memBytes: 1 });
  const ctx = {
    overrides: {},
    namespaces: new Map(['team-a-billing', 'team-a-search', 'team-a-web'].map(n => [n, 'Team A Apps'])),
  };

  it('uniqueNames keeps unique names and adds the id to repeated ones', () => {
    expect(
      uniqueNames([
        { name: 'Apps', id: 'a' },
        { name: 'Apps', id: 'b' },
        { name: 'Solo', id: 'c' },
      ])
    ).toEqual(['Apps (a)', 'Apps (b)', 'Solo']);
  });

  it('shows the real namespace id when namespaces share a display name', () => {
    const t = buildNodeTree(
      { ...metrics(), pods: ['team-a-billing', 'team-a-search', 'team-a-web', 'solo'].map(shared) },
      null,
      'cpu',
      icon,
      [],
      { ...ctx, namespaces: new Map([...ctx.namespaces, ['solo', 'Solo apps']]) }
    );
    const k8s = t.root.children.find(c => c.key === 'k8s')!;
    const labels = k8s.children.map(c => nameOf(c));
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels.sort()).toEqual([
      'Solo apps',
      'Team A Apps (team-a-billing)',
      'Team A Apps (team-a-search)',
      'Team A Apps (team-a-web)',
    ]);
  });
});
