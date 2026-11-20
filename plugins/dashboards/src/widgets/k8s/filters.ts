/*
 * Report filters: one test per row (field, operator, value), joined by AND, or by a custom logic
 * string such as `1 AND (2 OR 3)` as in Salesforce reports. All functions here are pure.
 */
import { getValues, Scalar, toNumber } from './fields';

export const FILTER_OPS = ['eq', 'ne', 'contains', 'startsWith', 'exists', 'gt', 'lt', 'in'] as const;
export type FilterOp = (typeof FILTER_OPS)[number];

export const FILTER_OP_LABELS: Record<FilterOp, string> = {
  eq: 'equals',
  ne: 'not equals',
  contains: 'contains',
  startsWith: 'starts with',
  exists: 'exists',
  gt: 'greater than',
  lt: 'less than',
  in: 'in (comma list)',
};

export interface ReportFilter {
  field: string;
  op: FilterOp;
  value: string;
}

const lower = (v: Scalar): string => String(v).toLowerCase();

function isNo(value: string): boolean {
  return ['false', 'no', '0'].includes(value.trim().toLowerCase());
}

/** Whether a list of values passes one filter. Several values (a wildcard or labels) match if any does. */
export function testFilter(values: Scalar[], filter: ReportFilter): boolean {
  const present = values.filter(v => v !== null && v !== '');
  const target = filter.value;
  switch (filter.op) {
    case 'exists': {
      // The value "false", "no" or "0" turns it into "does not exist".
      const exists = present.length > 0;
      return isNo(target) ? !exists : exists;
    }
    case 'eq':
      return present.some(v => equalsValue(v, target));
    case 'ne':
      return !present.some(v => equalsValue(v, target));
    case 'contains':
      return present.some(v => lower(v).includes(target.toLowerCase()));
    case 'startsWith':
      return present.some(v => lower(v).startsWith(target.toLowerCase()));
    case 'in': {
      const items = target
        .split(',')
        .map(s => s.trim())
        .filter(s => s !== '');
      return present.some(v => items.some(item => equalsValue(v, item)));
    }
    case 'gt':
    case 'lt': {
      const want = toNumber(target);
      if (want === null) return false;
      return present.some(v => {
        const n = toNumber(v);
        if (n === null) return false;
        return filter.op === 'gt' ? n > want : n < want;
      });
    }
    default:
      return false;
  }
}

function equalsValue(v: Scalar, target: string): boolean {
  const a = toNumber(v);
  const b = toNumber(target);
  if (a !== null && b !== null && typeof v !== 'boolean') return a === b;
  return lower(v) === target.toLowerCase();
}

/* ------------------------------ custom logic string ------------------------------ */

export type LogicNode =
  | { type: 'ref'; index: number }
  | { type: 'not'; child: LogicNode }
  | { type: 'and' | 'or'; left: LogicNode; right: LogicNode };

export type LogicResult = { ok: true; ast: LogicNode } | { ok: false; error: string };

interface Token {
  kind: 'num' | 'and' | 'or' | 'not' | 'open' | 'close';
  value?: number;
}

function tokenise(input: string): Token[] | string {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const c = input[i];
    if (/\s/.test(c)) {
      i += 1;
    } else if (c === '(') {
      tokens.push({ kind: 'open' });
      i += 1;
    } else if (c === ')') {
      tokens.push({ kind: 'close' });
      i += 1;
    } else if (/\d/.test(c)) {
      let j = i;
      while (j < input.length && /\d/.test(input[j])) j += 1;
      tokens.push({ kind: 'num', value: Number(input.slice(i, j)) });
      i = j;
    } else if (/[A-Za-z]/.test(c)) {
      let j = i;
      while (j < input.length && /[A-Za-z]/.test(input[j])) j += 1;
      const word = input.slice(i, j).toUpperCase();
      if (word === 'AND' || word === 'OR' || word === 'NOT') tokens.push({ kind: word.toLowerCase() as Token['kind'] });
      else return `Unknown word "${input.slice(i, j)}". Use AND, OR, NOT, numbers and brackets.`;
      i = j;
    } else {
      return `Unexpected character "${c}".`;
    }
  }
  return tokens;
}

/**
 * Parse a custom logic string. AND binds tighter than OR, NOT binds tightest. Numbers are
 * filter numbers (1 is the first filter). `count` is the number of filters. An unknown filter
 * number, a filter that the string leaves out, or a syntax error gives `{ ok: false, error }`.
 */
export function parseFilterLogic(input: string, count: number): LogicResult {
  const tokens = tokenise(input);
  if (typeof tokens === 'string') return { ok: false, error: tokens };
  if (tokens.length === 0) return { ok: false, error: 'The logic is empty.' };
  let pos = 0;
  const used = new Set<number>();
  let failure: string | null = null;
  const fail = (message: string): LogicNode => {
    failure ??= message;
    return { type: 'ref', index: 0 };
  };
  const peek = () => tokens[pos];
  const parseOr = (): LogicNode => {
    let left = parseAnd();
    while (peek()?.kind === 'or') {
      pos += 1;
      left = { type: 'or', left, right: parseAnd() };
    }
    return left;
  };
  const parseAnd = (): LogicNode => {
    let left = parseNot();
    while (peek()?.kind === 'and') {
      pos += 1;
      left = { type: 'and', left, right: parseNot() };
    }
    return left;
  };
  const parseNot = (): LogicNode => {
    if (peek()?.kind === 'not') {
      pos += 1;
      return { type: 'not', child: parseNot() };
    }
    return parseAtom();
  };
  const parseAtom = (): LogicNode => {
    const t = peek();
    if (!t) return fail('The logic ends too early.');
    pos += 1;
    if (t.kind === 'num') {
      const n = t.value as number;
      if (n < 1 || n > count) return fail(`Filter ${n} does not exist. There are ${count} filters.`);
      used.add(n);
      return { type: 'ref', index: n - 1 };
    }
    if (t.kind === 'open') {
      const inner = parseOr();
      if (peek()?.kind !== 'close') return fail('A bracket is not closed.');
      pos += 1;
      return inner;
    }
    return fail('A filter number or a bracket is missing.');
  };
  const ast = parseOr();
  if (failure) return { ok: false, error: failure };
  if (pos < tokens.length) return { ok: false, error: 'The logic has extra words at the end.' };
  for (let n = 1; n <= count; n += 1) {
    if (!used.has(n)) return { ok: false, error: `Filter ${n} is not in the logic.` };
  }
  return { ok: true, ast };
}

export function evaluateLogic(node: LogicNode, results: boolean[]): boolean {
  switch (node.type) {
    case 'ref':
      return results[node.index] === true;
    case 'not':
      return !evaluateLogic(node.child, results);
    case 'and':
      return evaluateLogic(node.left, results) && evaluateLogic(node.right, results);
    case 'or':
      return evaluateLogic(node.left, results) || evaluateLogic(node.right, results);
  }
}

/**
 * Build a predicate for a list of filters. An empty or invalid custom logic falls back to AND,
 * and `logicError` says why. A filter with an empty field is skipped (a draft row).
 */
export function compileFilters(
  filters: ReportFilter[],
  logic: string,
  now: number
): { test: (obj: unknown) => boolean; logicError: string | null } {
  const active = filters.filter(f => f.field.trim() !== '');
  let ast: LogicNode | null = null;
  let logicError: string | null = null;
  if (logic.trim() !== '' && filters.length > 0) {
    // The logic counts the filters as the user sees them, so keep draft rows in the numbering.
    const parsed = parseFilterLogic(logic, filters.length);
    if (parsed.ok) ast = parsed.ast;
    else logicError = parsed.error;
  }
  const test = (obj: unknown): boolean => {
    if (ast) {
      const results = filters.map(f => (f.field.trim() === '' ? true : testFilter(getValues(obj, f.field, now), f)));
      return evaluateLogic(ast, results);
    }
    return active.every(f => testFilter(getValues(obj, f.field, now), f));
  };
  return { test, logicError };
}
