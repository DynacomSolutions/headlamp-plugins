/**
 * Providers contributed by Headlamp plugins (`plugins/<plugin>/agent/provider.ts`).
 * Each exports `provider`; add one line per plugin; test/providers.test.ts fails when a plugin's
 * provider file exists but is not listed here.
 */
import { provider as alerting } from '../../../plugins/alerting/agent/provider.js';
import { provider as diskHealth } from '../../../plugins/disk-health/agent/provider.js';
import { provider as nodeHardware } from '../../../plugins/node-hardware/agent/provider.js';
import { provider as sites } from '../../../plugins/sites/agent/provider.js';
import { provider as updates } from '../../../plugins/updates/agent/provider.js';
import { provider as uptime } from '../../../plugins/uptime/agent/provider.js';
import { provider as usage } from '../../../plugins/usage/agent/provider.js';
import type { ProviderDefinition } from '../sdk.js';

export const pluginProviders: Record<string, ProviderDefinition> = {
  alerting,
  'disk-health': diskHealth,
  'node-hardware': nodeHardware,
  sites,
  updates,
  uptime,
  usage,
};
