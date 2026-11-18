/** Agent data provider for the updates plugin: component versions, available and blocked updates. */
import { defineProvider, defineTool, setting, z } from '../../../agent/src/sdk.js';

const report = defineTool({
  name: 'updates_components',
  title: 'Component versions and updates',
  description:
    'Installed and latest versions of cluster components from the version-tracker report, with update status and blockers. Use it to check whether a known bug is fixed in a newer release, or whether a node runs a different Kubernetes version.',
  input: z.object({
    status: z.enum(['available', 'blocked', 'unknown', 'up-to-date', 'any']).default('any'),
    component: z.string().optional().describe('Substring of the component id or name'),
  }),
  output: z.object({
    generatedAt: z.string(),
    kubernetes: z.object({ server: z.string(), nodes: z.array(z.object({ name: z.string(), version: z.string() })) }),
    components: z.array(
      z.object({ id: z.string(), name: z.string(), current: z.string(), latest: z.string(), status: z.string(), security: z.boolean(), blockers: z.array(z.string()), releaseNotesUrl: z.string() }),
    ),
  }),
  async run(args, ctx) {
    const label = setting(ctx.settings, 'labelSelector', 'app.kubernetes.io/name=version-tracker');
    const name = setting(ctx.settings, 'configMapName', 'version-tracker-report');
    const { items } = await ctx.kube.list('configmaps', { labelSelector: label });
    const cm = items.find(i => i.metadata?.name === name) ?? items[0];
    if (!cm) throw new Error(`No ConfigMap labelled ${label} was found`);
    const raw = JSON.parse(String((cm as any).data?.['report.json'] ?? '{}'));
    const f = args.component?.toLowerCase();
    const components = (Array.isArray(raw.components) ? raw.components : [])
      .filter((c: any) => args.status === 'any' || c.status === args.status)
      .filter((c: any) => !f || String(c.id).toLowerCase().includes(f) || String(c.name).toLowerCase().includes(f))
      .map((c: any) => ({
        id: String(c.id ?? ''),
        name: String(c.name ?? c.id ?? ''),
        current: String(c.current ?? ''),
        latest: String(c.latest ?? ''),
        status: String(c.status ?? 'unknown'),
        security: c.security === true,
        blockers: (Array.isArray(c.blockers) ? c.blockers : []).map((b: any) => `${b.reason ?? ''}${b.requires ? ` (needs ${b.requires})` : ''}`),
        releaseNotesUrl: String(c.releaseNotesUrl ?? ''),
      }));
    const kubernetes = {
      server: String(raw.kubernetes?.server ?? ''),
      nodes: (Array.isArray(raw.kubernetes?.nodes) ? raw.kubernetes.nodes : []).map((n: any) => ({ name: String(n.name ?? ''), version: String(n.version ?? '') })),
    };
    return {
      data: { generatedAt: String(raw.generatedAt ?? ''), kubernetes, components },
      summary: `${components.length} components${args.status !== 'any' ? ` with status ${args.status}` : ''}; Kubernetes server ${kubernetes.server}.`,
      view: { title: 'Component updates', rows: components.slice(0, 60).map((c: any) => ({ label: c.name, detail: `${c.current} → ${c.latest}${c.blockers.length ? ` · ${c.blockers.join('; ')}` : ''}`, status: c.status })) },
    };
  },
});

export const provider = defineProvider({
  name: 'updates',
  title: 'Updates',
  description: 'Component versions and update blockers from the version-tracker report (updates plugin)',
  tools: [report],
});
