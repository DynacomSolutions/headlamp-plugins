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
    const shutdown = new AbortController();
    const stop = () => shutdown.abort();
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
    try {
      const server = await startServer(undefined, VERSION, { signal: shutdown.signal });
      await new Promise<void>(resolve => {
        if (shutdown.signal.aborted) return resolve();
        shutdown.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      await server.close();
    } catch (error) {
      if (!shutdown.signal.aborted || error !== shutdown.signal.reason) throw error;
    } finally {
      process.off('SIGTERM', stop);
      process.off('SIGINT', stop);
    }
    return;
  }
  process.stderr.write('usage: headlamp-agent [serve|acp]\n');
  process.exit(2);
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
