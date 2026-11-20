/*
 * Checks for the names that go into an API path. A saved dashboard is data that other people can
 * write, so a group, a version, a plural or a namespace must never carry a `/`, a `..` or any
 * other part that could point the request at a different API path.
 */
import type { SourceRef } from './config';

/** A DNS label: lower case letters, digits and dashes, at most 63 characters. */
export const isDnsLabel = (s: unknown): s is string =>
  typeof s === 'string' && s.length <= 63 && /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(s);

/** A DNS subdomain: dot separated DNS labels, at most 253 characters. */
export const isDnsSubdomain = (s: unknown): s is string =>
  typeof s === 'string' &&
  s.length <= 253 &&
  /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/.test(s);

/** An API version such as `v1`, `v2beta1` or `v1alpha3`. */
export const isApiVersion = (s: unknown): s is string =>
  typeof s === 'string' && /^v\d+((alpha|beta)\d+)?$/.test(s);

/** The core group, with the plural `secrets`. Reports never list it, because the rows would show secret values. */
export const isSecretsSource = (group: string, plural: string): boolean =>
  group === '' && plural === 'secrets';

/** True when the group, version and plural are safe in a path and the source is not blocked. */
export function isSafeSource(s: Pick<SourceRef, 'group' | 'version' | 'plural'>): boolean {
  return (
    (s.group === '' || isDnsSubdomain(s.group)) &&
    isApiVersion(s.version) &&
    isDnsLabel(s.plural) &&
    !isSecretsSource(s.group, s.plural)
  );
}
