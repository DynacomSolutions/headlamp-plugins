import { getPointer } from './pointer';

/** Where dynamic values resolve: the surface data model and the template item (absolute pointer) if any. */
export interface Scope {
  data: unknown;
  /** Absolute JSON Pointer of the current template item, for example `/trail/0`. */
  base?: string;
}

/** Resolves a possibly relative path to an absolute pointer. */
export function absolutePath(path: string, scope: Scope): string {
  if (path.startsWith('/')) return path;
  const base = scope.base ?? '';
  return `${base}/${path}`;
}

export function isPathBinding(v: unknown): v is { '@path': string } {
  return (
    !!v && typeof v === 'object' && typeof (v as Record<string, unknown>)['@path'] === 'string'
  );
}

export function isCall(v: unknown): v is { '@call': string } {
  return (
    !!v && typeof v === 'object' && typeof (v as Record<string, unknown>)['@call'] === 'string'
  );
}

/** Literal, `{ "@path" }` binding, or undefined for anything else (function calls are ignored). */
export function resolveValue(v: unknown, scope: Scope): unknown {
  if (isPathBinding(v)) return getPointer(scope.data, absolutePath(v['@path'], scope));
  if (isCall(v)) return undefined;
  return v;
}

export function resolveString(v: unknown, scope: Scope): string {
  const r = resolveValue(v, scope);
  if (r === undefined || r === null) return '';
  if (typeof r === 'string') return r;
  if (typeof r === 'number' || typeof r === 'boolean') return String(r);
  return '';
}

export interface TemplateRef {
  path: string;
  componentId: string;
}

export function isTemplate(v: unknown): v is TemplateRef {
  return (
    !!v &&
    typeof v === 'object' &&
    !Array.isArray(v) &&
    typeof (v as TemplateRef).path === 'string' &&
    typeof (v as TemplateRef).componentId === 'string'
  );
}

/** Child references: ids, each with the scope it renders in. */
export interface ChildRef {
  id: string;
  scope: Scope;
  key: string;
}

export function resolveChildren(spec: unknown, scope: Scope): ChildRef[] {
  if (Array.isArray(spec)) {
    return spec
      .filter((id): id is string => typeof id === 'string')
      .map((id, i) => ({ id, scope, key: `${i}:${id}` }));
  }
  if (isTemplate(spec)) {
    const abs = absolutePath(spec.path, scope);
    const items = getPointer(scope.data, abs);
    if (!Array.isArray(items)) return [];
    return items.map((_, i) => ({
      id: spec.componentId,
      scope: { data: scope.data, base: `${abs === '/' ? '' : abs}/${i}` },
      key: `${i}`,
    }));
  }
  return [];
}
