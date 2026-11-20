/*
 * Template variables for PromQL queries. A query may use `$namespace`, `$node`, `$range`,
 * `$step`, `$rate` and `$selector` (also written `${name}`). They come from the dashboard
 * filters, so one query follows the filter bar. An unknown `$name` stays as it is, so a
 * query that uses a `$` for another reason is not changed.
 *
 *   $namespace  the chosen namespaces as a regex alternation, for `namespace=~"$namespace"`.
 *               No namespace chosen gives `.*`.
 *   $node       the same for nodes.
 *   $range      the time range, as a PromQL duration (`1h`), for `[$range]`.
 *   $step       the query step in seconds (`30s`).
 *   $rate       a window for rate(): four steps, at least one minute (`2m`).
 *   $selector   the label selector as PromQL matchers, for `up{$selector}`. Empty when there is none.
 */
import type { DashboardFilters } from '../../contract';

export type TemplateVars = Record<string, string>;

/** Escape a value for use inside a PromQL regex that sits in a double quoted string. */
export function escapeRegexForPromql(value: string): string {
  const regex = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return escapeString(regex);
}

/** Escape a value for use inside a PromQL double quoted string. */
export function escapeString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/** A regex alternation of the values, or `.*` for none. */
export function alternation(values: string[]): string {
  const items = values.filter(v => v !== '');
  return items.length === 0 ? '.*' : items.map(escapeRegexForPromql).join('|');
}

const LABEL_NAME = (key: string): string =>
  key.replace(/[^a-zA-Z0-9_]/g, '_').replace(/^(\d)/, '_$1');

function splitSelector(selector: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of selector) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts.map(p => p.trim()).filter(Boolean);
}

/**
 * Turn a Kubernetes label selector (`app=web,tier!=db,env in (a,b),!legacy`) into PromQL
 * matchers (`app="web",tier!="db",env=~"a|b",legacy=""`). A part that cannot be read is left out.
 */
export function selectorToMatchers(selector: string): string {
  const out: string[] = [];
  for (const part of splitSelector(selector)) {
    let m = /^([^\s=!()]+)\s*(!=|==|=)\s*(.*)$/.exec(part);
    if (m) {
      const op = m[2] === '!=' ? '!=' : '=';
      out.push(`${LABEL_NAME(m[1])}${op}"${escapeString(m[3].trim())}"`);
      continue;
    }
    m = /^([^\s=!()]+)\s+(in|notin)\s*\((.*)\)$/.exec(part);
    if (m) {
      const values = m[3]
        .split(',')
        .map(v => v.trim())
        .filter(Boolean);
      out.push(
        `${LABEL_NAME(m[1])}${m[2] === 'in' ? '=~' : '!~'}"${values
          .map(escapeRegexForPromql)
          .join('|')}"`
      );
      continue;
    }
    m = /^!\s*([^\s=!()]+)$/.exec(part);
    if (m) {
      out.push(`${LABEL_NAME(m[1])}=""`);
      continue;
    }
    m = /^([^\s=!()]+)$/.exec(part);
    if (m) out.push(`${LABEL_NAME(m[1])}=~".+"`);
  }
  return out.join(',');
}

/** A duration in whole seconds as a PromQL duration, for example 120 gives `2m`. */
export function formatDuration(seconds: number): string {
  const s = Math.max(1, Math.round(seconds));
  if (s % 86400 === 0) return `${s / 86400}d`;
  if (s % 3600 === 0) return `${s / 3600}h`;
  if (s % 60 === 0) return `${s / 60}m`;
  return `${s}s`;
}

export function buildVars(filters: DashboardFilters, stepSeconds: number): TemplateVars {
  return {
    namespace: alternation(filters.namespaces),
    node: alternation(filters.nodes),
    range: filters.range,
    step: `${Math.max(1, Math.round(stepSeconds))}s`,
    rate: formatDuration(Math.max(60, stepSeconds * 4)),
    selector: selectorToMatchers(filters.labelSelector),
  };
}

/** Replace `$name` and `${name}` with the variable values. */
export function substitute(query: string, vars: TemplateVars): string {
  return query.replace(
    /\$(?:\{(\w+)\}|(\w+))/g,
    (whole, braced: string | undefined, bare: string | undefined) => {
      const name = braced ?? bare ?? '';
      return Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : whole;
    }
  );
}
