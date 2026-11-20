/*
 * A table widget can hold several queries, one value column each. Separate them with a line
 * that holds only `---`. A first line of the form `# Title | unit` names the column and picks
 * its unit (the `#` line is also a valid PromQL comment, so the query runs as it is).
 */
import { isUnit, Unit } from './units';

export interface QueryBlock {
  title: string;
  unit: Unit | undefined;
  query: string;
}

export function parseBlocks(text: string): QueryBlock[] {
  const out: QueryBlock[] = [];
  for (const raw of text.split(/^\s*---\s*$/m)) {
    const lines = raw.split('\n');
    while (lines.length > 0 && lines[0].trim() === '') lines.shift();
    let title = '';
    let unit: Unit | undefined;
    const head = /^\s*#\s*([^|]*?)\s*(?:\|\s*(\w+)\s*)?$/.exec(lines[0] ?? '');
    if (head) {
      title = head[1];
      if (head[2] && isUnit(head[2])) unit = head[2];
      lines.shift();
    }
    const query = lines.join('\n').trim();
    if (query !== '') out.push({ title, unit, query });
  }
  return out;
}
