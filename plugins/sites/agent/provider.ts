/** Agent data provider for the sites plugin: which Service serves a hostname, from Emissary Mappings. */
import { defineProvider, defineTool, z } from '../../../agent/src/sdk.js';

const lookup = defineTool({
  name: 'sites_lookup',
  title: 'Find the Service behind a URL',
  description:
    'Searches Emissary Mapping resources by hostname, path, namespace or backing Service, and returns host, prefix and the Service each routes to. Use it to go from a failing URL or probe target to the workload that serves it.',
  input: z.object({ query: z.string().min(1).describe('Hostname, URL, Service name or namespace substring') }),
  output: z.object({ sites: z.array(z.object({ host: z.string(), prefix: z.string(), service: z.string(), namespace: z.string(), mapping: z.string() })) }),
  async run(args, ctx) {
    const q = args.query.toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    const { items } = await ctx.kube.list('mappings.getambassador.io', { limit: 2000 });
    const sites = items
      .map(m => ({
        host: String(m.spec?.hostname ?? m.spec?.host ?? '*'),
        prefix: String(m.spec?.prefix ?? '/'),
        service: String(m.spec?.service ?? ''),
        namespace: m.metadata?.namespace ?? '',
        mapping: m.metadata?.name ?? '',
      }))
      .filter(s => [s.host, s.service, s.namespace, s.mapping].some(v => v.toLowerCase().includes(q)));
    return {
      data: { sites },
      summary: `${sites.length} Mapping${sites.length === 1 ? '' : 's'} match "${args.query}".`,
      view: { title: 'Sites', rows: sites.map(s => ({ label: `${s.host}${s.prefix}`, detail: `${s.namespace}/${s.mapping}`, status: s.service })) },
    };
  },
});

export const provider = defineProvider({
  name: 'sites',
  title: 'Sites',
  description: 'Hostnames, paths and the Services behind them from Emissary Mappings (sites plugin)',
  tools: [lookup],
});
