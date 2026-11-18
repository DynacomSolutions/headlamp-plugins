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
    const stop = async () => {
      // Leave the Service endpoints before closing (readiness turns 503 first).
      setTimeout(() => void server.close().then(() => process.exit(0)), Number(process.env.SHUTDOWN_DELAY_MS ?? 3000));
    };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    return;
  }
  process.stderr.write('usage: headlamp-agent [serve|acp]\n');
  process.exit(2);
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
