#!/usr/bin/env node
/*
 * Fails when code that renders inside a dashboard or kiosk view has a link that leaves the
 * dashboard: an external link, a new-tab link, or a router link to another page.
 * See "Dashboard and kiosk links" in AGENTS.md.
 *
 * It starts from the entry files and follows relative imports (no `import type`), skips test files,
 * and checks each file line by line. No dependencies.
 *
 *   node scripts/check-dashboard-links.mjs                 check the real entry files
 *   node scripts/check-dashboard-links.mjs --entry <file>  check from the given entry files only
 *
 * A line can opt out with a comment on the same line: `// dashboard-links: allow <reason>`.
 * The reason is required. Add no marker for an external URL.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXTENSIONS = ['.ts', '.tsx'];

/** The one file that may use the router link: `InternalLink` keeps the link inside the dashboard. */
const ROUTER_LINK_FILE = 'plugins/dashboards/src/links.tsx';

/**
 * Files that the entry reaches but that are not a dashboard or kiosk view. They are followed for
 * imports but not checked. The list page is at `/dashboards`, where the user picks a dashboard.
 */
const NOT_A_DASHBOARD_VIEW = new Set(['plugins/dashboards/src/DashboardsListPage.tsx']);

const ALLOW = /dashboard-links:\s*allow\s+\S/;

/** [pattern, message, applies to the router-link file too]. Patterns run on the line without comments. */
const RULES = [
  [/['"`]_(blank|new|top|parent)['"`]/, 'opens a new tab or window (target _blank)', true],
  [/\bwindow\.open\s*\(/, 'window.open leaves the dashboard', true],
  [/\b(?:window|document|globalThis|self)\.location\s*=(?!=)/, 'assigns the location', true],
  [/\blocation\.href\s*=(?!=)/, 'assigns location.href', true],
  [/\blocation\.(assign|replace)\s*\(/, 'location.assign or location.replace leaves the dashboard', true],
  [/\bcomponent\s*=\s*["']a["']/, 'a link element (component="a")', true],
  [/<a[\s>]/, 'an anchor element', true],
  [/\bRouterLink\b/, 'RouterLink (use InternalLink from links.tsx)', false],
  [/\broute(Name|Params)\s*=/, 'a Headlamp route link (routeName=)', false],
  [/<(NavLink|Link)[\s>]/, 'a link component (use InternalLink from links.tsx)', false],
  [
    /\bimport\s*\{[^}]*\b(Link|NavLink)\b[^}]*\}\s*from\s*['"](react-router-dom|@kinvolk\/headlamp-plugin\/lib\/CommonComponents)['"]/,
    'imports a router or Headlamp link',
    false,
  ],
];

/** The line without `//` and block comments. Quotes are tracked so `https://` in a string stays. */
export function stripComments(line, state) {
  let out = '';
  let quote = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    const n = line[i + 1];
    if (state.block) {
      if (c === '*' && n === '/') {
        state.block = false;
        i++;
      }
      continue;
    }
    if (quote) {
      out += c;
      if (c === '\\') {
        out += n ?? '';
        i++;
      } else if (c === quote) quote = '';
      continue;
    }
    if (c === '/' && n === '*') {
      state.block = true;
      i++;
      continue;
    }
    if (c === '/' && n === '/') break;
    if (c === '"' || c === "'" || c === '`') quote = c;
    out += c;
  }
  return out;
}

/** SVG elements whose `href` loads a picture and is not a link. */
const HREF_OK_TAGS = new Set(['image', 'use', 'feImage']);

/**
 * The attributes of each JSX tag in the text, without the `{...}` values: [tag, attributes, offset].
 * `href=` and `target=` are checked here, because a tag can span several lines.
 */
function jsxTags(text) {
  const tags = [];
  const open = /<([A-Za-z][\w.]*)/g;
  for (let m; (m = open.exec(text)); ) {
    let depth = 0;
    let quote = '';
    let attrs = '';
    let i = m.index + m[0].length;
    const limit = Math.min(text.length, i + 4000);
    for (; i < limit; i++) {
      const c = text[i];
      if (quote) {
        if (c === '\\') i++;
        else if (c === quote) quote = '';
        if (depth === 0) attrs += c;
      } else if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (depth === 0 && c === '>') break;
      else {
        if (depth === 0) {
          attrs += c;
          if (c === '"' || c === "'") quote = c;
        } else if (c === '"' || c === "'" || c === '`') quote = c;
      }
    }
    tags.push([m[1], attrs, m.index]);
  }
  return tags;
}

export function checkSource(file, text) {
  const problems = [];
  const state = { block: false };
  const isRouterFile = file === ROUTER_LINK_FILE;
  const raws = text.split('\n');
  const lines = raws.map(raw => stripComments(raw, state));
  const allowed = raws.map(raw => ALLOW.test(raw));
  lines.forEach((line, i) => {
    if (allowed[i]) return;
    for (const [pattern, message, always] of RULES) {
      if (isRouterFile && !always) continue;
      if (pattern.test(line)) problems.push(`${file}:${i + 1}: ${message}`);
    }
  });
  const stripped = lines.join('\n');
  if (!file.endsWith('.tsx')) return [...new Set(problems)];
  for (const [tag, attrs, offset] of jsxTags(stripped)) {
    const line = stripped.slice(0, offset).split('\n').length;
    if (allowed[line - 1]) continue;
    if (/(?<![\w.-])href\s*=/.test(attrs) && !HREF_OK_TAGS.has(tag))
      problems.push(`${file}:${line}: <${tag}> has href`);
    if (/(?<![\w.-])target\s*=\s*["']/.test(attrs))
      problems.push(`${file}:${line}: <${tag}> sets a link target`);
  }
  return [...new Set(problems)];
}

const IMPORT =
  /(?:^|[\s;])(?:import|export)\s+(?!type\b)(?:[^'"]*?\sfrom\s*)?['"](\.{1,2}\/[^'"]*)['"]|\bimport\s*\(\s*['"](\.{1,2}\/[^'"]*)['"]\s*\)|\brequire\s*\(\s*['"](\.{1,2}\/[^'"]*)['"]\s*\)/g;

export function resolveImport(from, spec) {
  const base = path.resolve(path.dirname(from), spec);
  const candidates = [
    base,
    ...EXTENSIONS.map(e => base + e),
    ...EXTENSIONS.map(e => path.join(base, 'index' + e)),
  ];
  return candidates.find(f => EXTENSIONS.includes(path.extname(f)) && fs.existsSync(f) && fs.statSync(f).isFile());
}

const isTest = f => /\.(test|spec)\.[cm]?[jt]sx?$/.test(f);

export function importsOf(file, text) {
  const out = [];
  for (const m of text.matchAll(IMPORT)) {
    const target = resolveImport(file, m[1] ?? m[2] ?? m[3]);
    if (target) out.push(target);
  }
  return out;
}

export function defaultEntries(repo = REPO) {
  const entries = [path.join(repo, 'plugins/dashboards/src/index.tsx')];
  const plugins = path.join(repo, 'plugins');
  for (const p of fs.readdirSync(plugins)) {
    const f = path.join(plugins, p, 'src/dashboardWidgets.tsx');
    if (fs.existsSync(f)) entries.push(f);
  }
  return entries;
}

export function run(entries, repo = REPO) {
  const seen = new Set();
  const queue = [...entries];
  const problems = [];
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file) || isTest(file)) continue;
    seen.add(file);
    const text = fs.readFileSync(file, 'utf8');
    const rel = path.relative(repo, file).split(path.sep).join('/');
    if (!NOT_A_DASHBOARD_VIEW.has(rel)) problems.push(...checkSource(rel, text));
    queue.push(...importsOf(file, text));
  }
  return { problems: problems.sort(), files: seen.size };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const entries = [];
  for (let i = 0; i < args.length; i++)
    if (args[i] === '--entry') entries.push(path.resolve(args[++i]));
  const { problems, files } = run(entries.length ? entries : defaultEntries());
  if (problems.length) {
    console.error('A link in a dashboard or kiosk view must stay inside the dashboard:');
    for (const p of problems) console.error('  ' + p);
    console.error('See "Dashboard and kiosk links" in AGENTS.md.');
    process.exit(1);
  }
  console.log(`check-dashboard-links: ${files} files, no link leaves the dashboard.`);
}
