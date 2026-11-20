import type { ProviderDefinition } from '../sdk.js';
import kubernetes from './kubernetes.js';
import dnsPlacement from './dns-placement.js';
import metrics from './metrics.js';
import { pluginProviders } from './plugins.js';

/** Core providers (raw cluster data) followed by the plugin providers (what each plugin adds). */
export function allProviders(extra: ProviderDefinition[] = []): ProviderDefinition[] {
  return [kubernetes, metrics, dnsPlacement, ...Object.values(pluginProviders), ...extra];
}
