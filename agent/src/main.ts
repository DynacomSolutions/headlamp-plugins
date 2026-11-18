#!/usr/bin/env node
/**
 * headlamp-agent serve   HTTP: /mcp (MCP), /api/v2/alerts (vmalert notifier), /api/diagnoses
 * headlamp-agent acp     the incident-diagnosis agent over ACP on stdio
 */
import { startAcp } from './acp.js';
import { startServer } from './server.js';

const VERSION = process.env.HEADLAMP_AGENT_VERSION ?? '0.1.0';

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'serve';
  if (command === 'acp') return startAcp();
  if (command === 'serve') {
    const server = await startServer(undefined, VERSION);
    let stopping = false;
    const stop = () => {
      // A second signal ends the process at once.
      if (stopping) process.exit(1);
      stopping = true;
      // Readiness turns 503, new connections stop, and the running diagnosis finishes. No timer: the platform kill is the only limit.
      void server.close().then(() => process.exit(0));
    };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
    return;
  }
  process.stderr.write('usage: headlamp-agent [serve|acp]\n');
  process.exit(2);
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
