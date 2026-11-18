/** Agent data provider for the alerting plugin: the watchdog's live target state and recent episodes. */
import { defineProvider, defineTool, setting, z } from '../../../agent/src/sdk.js';

const targetSchema = z.object({
  target: z.string(),
  kind: z.string(),
  phase: z.string(),
  up: z.boolean().nullable(),
  downSince: z.string().nullable(),
  lastError: z.string(),
  lastStatusCode: z.number().nullable(),
  lastLatencyMs: z.number().nullable(),
});

function when(seconds: unknown): string | null {
  return typeof seconds === 'number' && seconds > 0 ? new Date(seconds * 1000).toISOString() : null;
}

const state = defineTool({
  name: 'alerting_watchdog_state',
  title: 'Watchdog targets and episodes',
  description:
    'The alerting backend (watchdog) state: every monitored target (deployments, routes, disks, probes) with phase, down-since and last error, plus recent down episodes. Use it to see what else is down at the same time as an alert.',
  input: z.object({
    onlyDown: z.boolean().default(true).describe('Only targets that are not up'),
    target: z.string().optional().describe('Substring of the target name'),
  }),
  output: z.object({
    generatedAt: z.string(),
    targets: z.array(targetSchema),
    recentEpisodes: z.array(z.object({ target: z.string(), started: z.string(), ended: z.string().nullable(), alerted: z.boolean() })),
  }),
  async run(args, ctx) {
    const url = setting(ctx.settings, 'stateUrl', '');
    if (!url) throw new Error('The alerting provider has no stateUrl setting (the alerting backend state endpoint)');
    const body = (await ctx.serviceGet(url)) as { generated_at?: string; targets?: any[]; episodes?: any[] };
    const f = args.target?.toLowerCase();
    const targets = (body.targets ?? [])
      .filter(t => !args.onlyDown || t.up === false || (t.phase && t.phase !== 'up'))
      .filter(t => !f || String(t.target).toLowerCase().includes(f))
      .map(t => ({
        target: String(t.target ?? ''),
        kind: String(t.kind ?? ''),
        phase: String(t.phase ?? ''),
        up: typeof t.up === 'boolean' ? t.up : null,
        downSince: when(t.down_since),
        lastError: String(t.last_error ?? '').slice(0, 300),
        lastStatusCode: typeof t.last_status_code === 'number' ? t.last_status_code : null,
        lastLatencyMs: typeof t.last_latency_ms === 'number' ? t.last_latency_ms : null,
      }));
    const recentEpisodes = (body.episodes ?? [])
      .filter(e => !f || String(e.target).toLowerCase().includes(f))
      .slice(0, 30)
      .map(e => ({ target: String(e.target ?? ''), started: String(e.started ?? ''), ended: e.ended ? String(e.ended) : null, alerted: Boolean(e.alerted) }));
    return {
      data: { generatedAt: String(body.generated_at ?? ''), targets, recentEpisodes },
      summary: `${targets.length} ${args.onlyDown ? 'down ' : ''}watchdog target${targets.length === 1 ? '' : 's'}, ${recentEpisodes.length} recent episodes.`,
      view: {
        title: 'Watchdog targets',
        rows: targets.map(t => ({ label: t.target, detail: t.lastError || t.kind, status: `${t.phase}${t.downSince ? ` since ${t.downSince.slice(0, 16).replace('T', ' ')}` : ''}` })),
      },
    };
  },
});

export const provider = defineProvider({
  name: 'alerting',
  title: 'Alerting',
  description: 'Watchdog target state and down episodes (alerting plugin)',
  tools: [state],
});
