import type { Metrics } from '../metrics.js';

/** The MCP metrics of contract appendix A, on the shared registry. */
export class McpMetrics {
  constructor(private readonly m: Metrics) {
    for (const reason of ['unconfigured', 'missing', 'invalid', 'scope', 'origin', 'bad_scopes']) m.inc('headlamp_agent_mcp_auth_failures_total', { reason }, 0);
  }

  toolCall(tool: string, client: string): void {
    this.m.inc('headlamp_agent_mcp_tool_calls_total', { tool, client });
  }

  toolError(tool: string, code: string): void {
    this.m.inc('headlamp_agent_mcp_tool_errors_total', { tool, code });
  }

  authFailure(reason: 'unconfigured' | 'missing' | 'invalid' | 'scope' | 'origin' | 'bad_scopes'): void {
    this.m.inc('headlamp_agent_mcp_auth_failures_total', { reason });
  }

  eventSent(kind: string): void {
    this.m.inc('headlamp_agent_mcp_events_sent_total', { kind });
  }

  eventRecorded(kind: string): void {
    this.m.inc('headlamp_agent_mcp_events_recorded_total', { kind });
  }

  gauges(g: { sessions: number; subscriptions: number; streams: number; logEvents?: number }): void {
    this.m.set('headlamp_agent_mcp_sessions_active', {}, g.sessions);
    this.m.set('headlamp_agent_mcp_subscriptions_active', {}, g.subscriptions);
    this.m.set('headlamp_agent_mcp_push_streams_active', {}, g.streams);
    if (g.logEvents !== undefined) this.m.set('headlamp_agent_mcp_event_log_events', {}, g.logEvents);
  }
}
