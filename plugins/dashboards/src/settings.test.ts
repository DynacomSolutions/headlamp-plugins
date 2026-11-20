import { describe, expect, it, vi } from 'vitest';

vi.mock('@kinvolk/headlamp-plugin/lib', () => ({
  ConfigStore: class {
    useConfig() {
      return () => undefined;
    }
  },
}));

import { isNamespaceName, resolveNamespace } from './settings';
import { DEFAULT_NAMESPACE } from './storage/storage';

describe('namespace setting', () => {
  it('defaults to headlamp-dashboards', () => {
    expect(DEFAULT_NAMESPACE).toBe('headlamp-dashboards');
    expect(resolveNamespace(undefined)).toBe(DEFAULT_NAMESPACE);
    expect(resolveNamespace({ namespace: '  ' })).toBe(DEFAULT_NAMESPACE);
  });
  it('uses a valid name and falls back from an invalid one', () => {
    expect(resolveNamespace({ namespace: ' team-a ' })).toBe('team-a');
    expect(resolveNamespace({ namespace: 'Bad_Name' })).toBe(DEFAULT_NAMESPACE);
    expect(isNamespaceName('a')).toBe(true);
    expect(isNamespaceName('-a')).toBe(false);
    expect(isNamespaceName('a'.repeat(64))).toBe(false);
  });
});
