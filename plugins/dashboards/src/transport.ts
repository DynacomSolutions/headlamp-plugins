import { ApiProxy } from '@kinvolk/headlamp-plugin/lib';
import type { Transport } from './storage/storage';

/** Headlamp's authenticated Kubernetes API client. */
export const apiTransport: Transport = {
  request: (path, params) => ApiProxy.request(path, params),
};

/**
 * Whether the user may use `verbs` (default: create, update and delete) on ConfigMaps in the namespace, asked of the API server with a
 * SelfSubjectAccessReview. Returns undefined when the check itself fails, and the caller then
 * lets the user try (a refused save still shows the read-only message).
 */
export async function canWriteConfigMaps(
  transport: Transport,
  namespace: string,
  verbs: ReadonlyArray<string> = ['create', 'update', 'delete']
): Promise<boolean | undefined> {
  const check = async (verb: string): Promise<boolean> => {
    const res = await transport.request('/apis/authorization.k8s.io/v1/selfsubjectaccessreviews', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apiVersion: 'authorization.k8s.io/v1',
        kind: 'SelfSubjectAccessReview',
        spec: { resourceAttributes: { namespace, verb, resource: 'configmaps' } },
      }),
    });
    return res?.status?.allowed === true;
  };
  try {
    const results = await Promise.all(verbs.map(check));
    return results.every(Boolean);
  } catch {
    return undefined;
  }
}
