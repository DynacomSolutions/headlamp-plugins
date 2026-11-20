/* The Headlamp page of a resource, for the row links. Returns null when no page is known. */
import { K8s, Router } from '@kinvolk/headlamp-plugin/lib';
import type { SourceRef } from './config';

export function resourceLink(obj: any, source: SourceRef): string | null {
  const name = obj?.metadata?.name;
  if (typeof name !== 'string') return null;
  const namespace = obj?.metadata?.namespace;
  try {
    const Cls = source.group === '' || !isCustomGroup(source.group) ? (K8s.ResourceClasses as Record<string, any>)[source.kind] : undefined;
    if (Cls) return new Cls(obj).getDetailsLink();
    if (isCustomGroup(source.group)) {
      return Router.createRouteURL('customresource', {
        crd: `${source.plural}.${source.group}`,
        namespace: namespace || '-',
        crName: name,
      });
    }
  } catch {
    // An unknown route or a class that rejects the object: show the row without a link.
  }
  return null;
}

function isCustomGroup(group: string): boolean {
  return group !== '' && !/^(apps|batch|policy|autoscaling|extensions)$/.test(group) && !/(^|\.)k8s\.io$/.test(group);
}
