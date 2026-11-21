import { describe, expect, it } from 'vitest';
import type { Sample } from '../promql/mapping';
import { DEFAULT_NET_FLOW, groupQueryFor, normaliseConfig, queriesFor } from './config';
import {
  buildFlow,
  FlowInput,
  FlowOptions,
  formatShare,
  graphHeight,
  lineWidth,
  nodeNames,
  pairLines,
  ringLayout,
  summaryText,
  viewFor,
} from './model';

const options: FlowOptions = {
  warnAbove: 0,
  critAbove: 0.02,
  nodeWarnAbove: 0.005,
  nodeCritAbove: 0.02,
};

const s = (labels: Record<string, string>, value: number | null): Sample => ({
  key: JSON.stringify(labels),
  labels,
  name: '',
  value,
});
const ping = (source: string, target: string, network: string, value: number | null) =>
  s({ source, target, network }, value);
const bytes = (source: string, target: string, network: string, direction: string, v: number) =>
  s({ source, target, network, direction }, v);

const empty: FlowInput = {
  loss: [],
  rtt: [],
  bytes: [],
  nodes: [],
  groups: { lan: [], tailnet: [], pod: [] },
  retrans: [],
};

describe('pair join', () => {
  it('makes one pair for each two nodes and joins both directions', () => {
    const m = buildFlow(
      {
        ...empty,
        loss: [
          ping('a', 'b', 'tailnet', 0),
          ping('b', 'a', 'tailnet', 0.03),
          ping('a', 'c', 'tailnet', 0.01),
        ],
      },
      options
    );
    expect(m.nodes).toEqual(['a', 'b', 'c']);
    // 3 nodes give 3 pairs, whatever the direction of the series.
    expect(m.pairs.map(p => `${p.a}${p.b}`)).toEqual(['ab', 'ac', 'bc']);
    const ab = m.pairs[0].nets[0];
    expect(ab.network).toBe('tailnet');
    expect(ab.ab.loss).toBe(0);
    expect(ab.ba.loss).toBe(0.03);
    // The worse direction is the loss of the pair.
    expect(ab.loss).toBe(0.03);
    expect(ab.status).toBe('crit');
    expect(m.pairs[1].nets[0].status).toBe('warn');
  });

  it('keeps the larger value when two probes report one direction', () => {
    const m = buildFlow(
      { ...empty, loss: [ping('a', 'b', 'lan', 0.001), ping('a', 'b', 'lan', 0.04)] },
      options
    );
    expect(m.pairs[0].nets[0].ab.loss).toBe(0.04);
  });

  it('sorts node names in natural order', () => {
    const m = buildFlow(
      { ...empty, loss: [ping('n10', 'n2', 'lan', 0), ping('n2', 'n1', 'lan', 0)] },
      options
    );
    expect(m.nodes).toEqual(['n1', 'n2', 'n10']);
  });

  it('ignores a series with an unknown network, a missing label or a self pair', () => {
    const m = buildFlow(
      {
        ...empty,
        loss: [
          ping('a', 'b', 'wireguard', 0.5),
          ping('a', 'a', 'lan', 0.5),
          s({ source: 'a', network: 'lan' }, 0.5),
          ping('a', 'b', 'LAN', 0),
        ],
      },
      options
    );
    expect(m.nodes).toEqual(['a', 'b']);
    expect(m.pairs[0].nets.map(n => n.network)).toEqual(['lan']);
    expect(m.pairs[0].nets[0].loss).toBe(0);
  });
});

describe('missing data', () => {
  const m = buildFlow(
    {
      ...empty,
      loss: [
        ping('a', 'b', 'tailnet', 0),
        ping('b', 'a', 'tailnet', 0),
        ping('a', 'c', 'lan', null),
      ],
      rtt: [ping('b', 'c', 'public', 0.02)],
    },
    options
  );

  it('keeps a pair with no loss as no data, never as zero', () => {
    const v = viewFor(m, 'all');
    const bc = v.pairs.find(p => p.a === 'b' && p.b === 'c')!;
    expect(bc.loss).toBeNull();
    expect(bc.status).toBe('unknown');
    const ac = v.pairs.find(p => p.a === 'a' && p.b === 'c')!;
    expect(ac.loss).toBeNull();
    expect(ac.status).toBe('unknown');
    expect(v.pairs.find(p => p.a === 'a' && p.b === 'b')!.status).toBe('ok');
  });

  it('shows a network with no data as no data on every pair', () => {
    for (const net of ['lan', 'public'] as const) {
      const v = viewFor(m, net);
      expect(v.pairs.every(p => p.loss === null && p.status === 'unknown')).toBe(true);
      expect(v.summary.noData).toBe(3);
      expect(v.status).toBe('unknown');
    }
    expect(viewFor(m, 'tailnet').pairs.filter(p => p.status === 'unknown')).toHaveLength(2);
  });

  it('counts the pairs with data for each network', () => {
    const v = viewFor(m, 'all');
    expect(v.summary.pairs).toBe(3);
    expect(v.summary.withData).toEqual({ tailnet: 1, lan: 0, public: 0 });
  });

  it('is empty without any series', () => {
    const e = buildFlow(empty, options);
    expect(e.nodes).toEqual([]);
    expect(viewFor(e, 'all').pairs).toEqual([]);
  });

  it('shows the tooltip of a pair with no data as no data', () => {
    const v = viewFor(m, 'lan');
    expect(pairLines(v.pairs[0])).toEqual(['a and b', 'no data']);
  });
});

describe('selection', () => {
  const m = buildFlow(
    {
      ...empty,
      loss: [
        ping('a', 'b', 'tailnet', 0.001),
        ping('a', 'b', 'lan', 0.05),
        ping('b', 'a', 'public', 0),
        ping('a', 'c', 'tailnet', 0),
      ],
    },
    options
  );

  it('takes the worst loss of every network for "all"', () => {
    const v = viewFor(m, 'all');
    const ab = v.pairs[0];
    expect(ab.loss).toBe(0.05);
    expect(ab.status).toBe('crit');
    expect(ab.worst).toEqual({ from: 'a', to: 'b', loss: 0.05, network: 'lan' });
    expect(v.summary.above).toBe(1);
    expect(v.summary.worst).toEqual({ from: 'a', to: 'b', loss: 0.05, network: 'lan' });
    expect(v.status).toBe('crit');
  });

  it('takes one network only for a chip', () => {
    const v = viewFor(m, 'tailnet');
    expect(v.pairs[0].loss).toBe(0.001);
    expect(v.pairs[0].status).toBe('warn');
    expect(v.summary.above).toBe(0);
    expect(v.status).toBe('warn');
    // The pair a and c has no public series at all.
    expect(viewFor(m, 'public').pairs[1].loss).toBeNull();
  });

  it('does not call a value equal to the limit critical', () => {
    const e = buildFlow({ ...empty, loss: [ping('a', 'b', 'lan', 0.02)] }, options);
    expect(viewFor(e, 'lan').pairs[0].status).toBe('warn');
  });

  it('writes the summary line', () => {
    expect(summaryText(viewFor(m, 'all'), 0.02)).toBe(
      '3 pairs, with data: Tailnet 2, LAN 1, Public 1, 1 above 2%, worst a to b 5%'
    );
    expect(summaryText(viewFor(buildFlow(empty, options), 'all'), 0.02)).toBe(
      '0 pairs, with data: Tailnet 0, LAN 0, Public 0, 0 above 2%'
    );
  });
});

describe('rate maths', () => {
  it('reads tx on the source and rx on the target as one flow, and takes the larger', () => {
    const m = buildFlow(
      {
        ...empty,
        loss: [ping('a', 'b', 'tailnet', 0)],
        bytes: [
          // a sent 1000 to b. b received 900 from a. The larger value wins.
          bytes('a', 'b', 'tailnet', 'tx', 1000),
          bytes('b', 'a', 'tailnet', 'rx', 900),
          // b sent 50 to a: only the rx side of a reports it.
          bytes('a', 'b', 'tailnet', 'rx', 50),
        ],
      },
      options
    );
    const n = m.pairs[0].nets[0];
    expect(n.ab.rate).toBe(1000);
    expect(n.ba.rate).toBe(50);
    expect(n.rate).toBe(1050);
  });

  it('keeps a missing direction as no data and a real zero as zero', () => {
    const m = buildFlow(
      {
        ...empty,
        loss: [ping('a', 'b', 'tailnet', 0)],
        bytes: [bytes('a', 'b', 'tailnet', 'tx', 0)],
      },
      options
    );
    const n = m.pairs[0].nets[0];
    expect(n.ab.rate).toBe(0);
    expect(n.ba.rate).toBeNull();
    expect(n.rate).toBe(0);
    expect(
      buildFlow({ ...empty, loss: [ping('a', 'b', 'lan', 0)] }, options).pairs[0].nets[0].rate
    ).toBeNull();
  });

  it('ignores a negative rate and an unknown direction', () => {
    const m = buildFlow(
      {
        ...empty,
        loss: [ping('a', 'b', 'tailnet', 0)],
        bytes: [bytes('a', 'b', 'tailnet', 'tx', -5), bytes('a', 'b', 'tailnet', 'both', 9)],
      },
      options
    );
    expect(m.pairs[0].nets[0].rate).toBeNull();
  });

  it('adds the traffic of every network for "all"', () => {
    const m = buildFlow(
      {
        ...empty,
        bytes: [bytes('a', 'b', 'tailnet', 'tx', 100), bytes('a', 'b', 'lan', 'tx', 300)],
      },
      options
    );
    expect(viewFor(m, 'all').pairs[0].rate).toBe(400);
    expect(viewFor(m, 'lan').pairs[0].rate).toBe(300);
    expect(viewFor(m, 'all').maxRate).toBe(400);
    // A pair with traffic but no loss series is still a pair, with no loss data.
    expect(viewFor(m, 'all').pairs[0].loss).toBeNull();
  });

  it('scales the line width from a thin minimum to the maximum', () => {
    expect(lineWidth(null, 100)).toBe(1);
    expect(lineWidth(0, 100)).toBe(1);
    expect(lineWidth(50, 0)).toBe(1);
    expect(lineWidth(100, 100)).toBe(5);
    expect(lineWidth(400, 100)).toBe(5);
    expect(lineWidth(25, 100)).toBeCloseTo(3, 5);
    expect(lineWidth(1, 1e9)).toBeGreaterThan(1);
    expect(lineWidth(1, 1e9)).toBeLessThan(1.01);
  });
});

describe('node health', () => {
  const nodes = [
    s({ instance: '192.0.2.1:9100', nodename: 'a' }, 1),
    s({ instance: '192.0.2.2:9100', nodename: 'b' }, 1),
    s({ instance: '192.0.2.3:9100', nodename: 'c' }, 1),
  ];
  const by = (instance: string, v: number | null) => s({ instance }, v);

  it('maps an instance to its node name', () => {
    const name = nodeNames(nodes);
    expect(name('192.0.2.2:9100')).toBe('b');
    expect(name('192.0.2.9:9100')).toBe('192.0.2.9');
  });

  it('joins the shares by node and takes the worst group', () => {
    const m = buildFlow(
      {
        ...empty,
        loss: [ping('a', 'b', 'lan', 0), ping('a', 'c', 'lan', 0)],
        nodes,
        groups: {
          lan: [by('192.0.2.1:9100', 0.0001), by('192.0.2.2:9100', 0)],
          tailnet: [by('192.0.2.1:9100', 0.03), by('192.0.2.2:9100', 0.006)],
          pod: [by('192.0.2.1:9100', 0.001)],
        },
        retrans: [by('192.0.2.1:9100', 0.004)],
      },
      options
    );
    const [a, b, c] = m.health;
    expect(a).toMatchObject({ name: 'a', worst: 0.03, status: 'crit', retransmit: 0.004 });
    expect(a.groups).toEqual({ lan: 0.0001, tailnet: 0.03, pod: 0.001 });
    expect(b).toMatchObject({ name: 'b', worst: 0.006, status: 'warn', retransmit: null });
    expect(b.groups.pod).toBeNull();
    // No interface data: no data, never zero.
    expect(c).toMatchObject({ name: 'c', worst: null, status: 'unknown' });
    expect(c.groups).toEqual({ lan: null, tailnet: null, pod: null });
  });

  it('keeps only the nodes of the graph', () => {
    const m = buildFlow(
      { ...empty, loss: [ping('a', 'b', 'lan', 0)], nodes, retrans: [by('192.0.2.3:9100', 0.5)] },
      options
    );
    expect(m.health.map(h => h.name)).toEqual(['a', 'b']);
  });
});

describe('share format', () => {
  it('reads a share as a percent, with no exponent and no false zero', () => {
    expect(formatShare(null)).toBe('no data');
    expect(formatShare(0)).toBe('0%');
    expect(formatShare(0.0123)).toBe('1.23%');
    expect(formatShare(0.0000082)).toBe('<0.001%');
    expect(formatShare(0.00002)).toBe('0.002%');
  });
});

describe('layout', () => {
  it('puts the first node at the top and goes clockwise', () => {
    const p = ringLayout(4, 100, 50, 80, 40);
    expect(p[0].x).toBeCloseTo(100);
    expect(p[0].y).toBeCloseTo(10);
    expect(p[1].x).toBeCloseTo(180);
    expect(p[1].y).toBeCloseTo(50);
    expect(p[2].y).toBeCloseTo(90);
    expect(p[3].x).toBeCloseTo(20);
  });

  it('gives the same places for the same count, and the centre for one node', () => {
    expect(ringLayout(6, 10, 10, 5, 5)).toEqual(ringLayout(6, 10, 10, 5, 5));
    expect(ringLayout(1, 10, 20, 5, 5)).toEqual([{ x: 10, y: 20 }]);
    expect(ringLayout(0, 10, 20, 5, 5)).toEqual([]);
  });

  it('sizes the graph from the widget, within limits', () => {
    expect(graphHeight(420, 330)).toBeGreaterThanOrEqual(110);
    expect(graphHeight(420, 330)).toBeLessThanOrEqual(330 - 30 - 56 + 1);
    expect(graphHeight(420, 600)).toBeGreaterThan(graphHeight(420, 330));
    // A wide and short widget never gets a graph wider than it is tall by more than the width allows.
    expect(graphHeight(100, 900)).toBe(110);
    expect(graphHeight(420, 40)).toBe(110);
  });
});

describe('config', () => {
  it('keeps the live defaults and the old tailnet series as a fallback', () => {
    const c = normaliseConfig(undefined);
    expect(c).toEqual(DEFAULT_NET_FLOW);
    expect(c.lossQuery).toContain('net_ping_loss_ratio');
    expect(c.lossQuery).toContain('tailnet_ping_loss_ratio');
    expect(c.bytesQuery).toContain('net_peer_bytes_total');
  });

  it('replaces bad numbers and blank required fields', () => {
    const c = normaliseConfig({
      critAbove: 'x' as unknown as number,
      lossQuery: ' ',
      warnAbove: 0.01,
    });
    expect(c.critAbove).toBe(0.02);
    expect(c.warnAbove).toBe(0.01);
    expect(c.lossQuery).toBe(DEFAULT_NET_FLOW.lossQuery);
  });

  it('builds the eight queries with the device regex of each group', () => {
    const q = queriesFor(DEFAULT_NET_FLOW);
    expect(q).toHaveLength(8);
    expect(q[4]).toContain('device=~"eno.*|enp.*|ens.*|eth.*"');
    expect(q[5]).toContain('device=~"tailscale.*"');
    expect(q[6]).toContain('device=~"flannel.*|cni0|veth.*"');
    expect(q.join('')).not.toContain('{{');
    expect(groupQueryFor({ ...DEFAULT_NET_FLOW, lanDevices: 'x0' }, 'lan')).toContain(
      'device=~"x0"'
    );
  });
});
