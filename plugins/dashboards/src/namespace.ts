/* The namespace setting of the Dashboards plugin. It is plain code, so any module can use it. */
import { DEFAULT_NAMESPACE } from './storage/storage';

/** A Kubernetes namespace name: a DNS label. */
export const isNamespaceName = (s: string): boolean =>
  /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/.test(s);

/** The namespace that holds the dashboard ConfigMaps. A blank or invalid setting gives the default. */
export function resolveNamespace(stored: Record<string, unknown> | undefined): string {
  const v = typeof stored?.namespace === 'string' ? stored.namespace.trim() : '';
  return isNamespaceName(v) ? v : DEFAULT_NAMESPACE;
}
