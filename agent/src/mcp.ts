import { randomUUID } from 'node:crypto';
import { createMcpHandler, McpServer, ResourceTemplate, type McpHttpHandler } from '@modelcontextprotocol/server';
import { SkillCatalog, memorySkillFiles } from '@modelcontextprotocol/server/ext/skills';
import { z } from 'zod';
import { A2UI_MIME, SUMMARY_VIEW_URI, summaryViewTemplate } from './a2ui/index.js';
import { readSkill } from './agent/skill.js';
import type { Runtime } from './runtime.js';
import type { DiagnosisStore } from './store.js';

export const SERVER_NAME = 'headlamp-agent';
export const DIAGNOSIS_URI = 'a2ui://headlamp-agent/diagnoses/{id}';

const INSTRUCTIONS = `Read-only view of a Kubernetes cluster and everything its Headlamp plugins see: resources, events, pod logs, metrics (PromQL), vmalert alerts and rules, SMART disk health, disk performance and capacity, node temperatures, uptime probes, component updates, sites and the alerting backend's target state. Nothing here can change the cluster, and secrets are masked.
Start an investigation with cluster_overview or list_alerts. To diagnose an alert, use the diagnose_incident prompt or the incident-diagnosis skill, and check list_diagnoses first: the cluster's own agent may already have diagnosed it.
Every tool returns structuredContent, a text summary and an A2UI v1.0 data update (application/a2ui+json) for the template at ${SUMMARY_VIEW_URI}.`;

/** Builds the stateless MCP handler (2026-07-28 per-request envelope, plus 2025-era clients without sessions). */
export async function mcpHandler(runtime: Runtime, store: DiagnosisStore, version: string): Promise<McpHttpHandler> {
  const skill = readSkill();
  const catalog = await SkillCatalog.load(memorySkillFiles({ 'incident-diagnosis/SKILL.md': skill.raw }), { prefix: SERVER_NAME });
  const template = JSON.stringify(summaryViewTemplate());
  const ui = { resourceUri: SUMMARY_VIEW_URI, mimeType: A2UI_MIME };

  const factory = () => {
    const server = new McpServer({ name: SERVER_NAME, version, title: 'Headlamp agent layer' }, { instructions: INSTRUCTIONS });

    for (const entry of runtime.registry.tools.values()) {
      const { tool, provider } = entry;
      server.registerTool(
        tool.name,
        {
          title: tool.title,
          description: `${tool.description} [${provider.title}]`,
          inputSchema: tool.input,
          outputSchema: tool.output,
          annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
          _meta: { ui, 'headlamp-agent/provider': provider.name },
        },
        async (args: unknown) => {
          const out = await runtime.registry.call(tool.name, args, p => runtime.context(p));
          const a2ui = {
            type: 'resource' as const,
            resource: { uri: `a2ui://headlamp-agent/results/${tool.name}/${randomUUID()}`, mimeType: A2UI_MIME, text: JSON.stringify(out.a2ui) },
          };
          if (!out.ok) return { isError: true, content: [{ type: 'text' as const, text: out.summary }, a2ui], _meta: { ui } };
          return {
            content: [{ type: 'text' as const, text: `${out.summary}\n${JSON.stringify(out.data)}` }, a2ui],
            structuredContent: out.data as Record<string, unknown>,
            _meta: { ui },
          };
        },
      );
    }

    server.registerResource(
      'summary-list-view',
      SUMMARY_VIEW_URI,
      { title: 'A2UI view for tool results', description: 'A2UI v1.0 template (basic catalog) that every tool result fills with an updateDataModel.', mimeType: A2UI_MIME },
      async uri => ({ contents: [{ uri: uri.href, mimeType: A2UI_MIME, text: template }] }),
    );

    server.registerResource(
      'diagnosis-surface',
      new ResourceTemplate(DIAGNOSIS_URI, {
        list: async () => ({
          resources: store
            .list()
            .slice(0, 50)
            .map(d => ({ uri: DIAGNOSIS_URI.replace('{id}', d.id), name: `${d.alert.name} ${d.createdAt}`, mimeType: A2UI_MIME })),
        }),
      }),
      { title: 'Diagnosis as an A2UI surface', description: 'A self-contained A2UI v1.0 surface for one diagnosis.', mimeType: A2UI_MIME },
      async (uri, variables) => {
        const id = String(variables.id ?? '');
        const d = store.get(id);
        if (!d) throw new Error(`No diagnosis ${id}`);
        return { contents: [{ uri: uri.href, mimeType: A2UI_MIME, text: JSON.stringify(d.a2ui) }] };
      },
    );

    server.registerPrompt(
      'diagnose_incident',
      {
        title: 'Diagnose an incident',
        description: skill.description,
        argsSchema: z.object({ alert: z.string().describe('The alert: its name and labels, a pasted alert payload or a description of the symptom') }),
      },
      async ({ alert }) => ({
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: `${skill.body}\n\n## Alert\n${alert}\n\nYou have no submit_diagnosis tool here: give the final answer as text with the same parts (likely cause, summary, confidence, signals with the tool results they rest on, fixes, how to confirm). Keep to about 10 tool calls.`,
            },
          },
        ],
      }),
    );

    catalog.attach(server);
    return server;
  };

  return createMcpHandler(factory, { responseMode: 'json' });
}
