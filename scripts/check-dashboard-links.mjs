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
 * It is a text check. It blocks the usual ways to build a link that leaves the dashboard: anchors,
 * link components, `href`, `to` and `target` props or keys, prop spreads on components, history and
 * location calls, and `window.open`. It cannot prove that code is safe.
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

/**
 * Files that may drive the router or the history directly. Each one only writes a path or the query
 * of the dashboard that is on screen. No other file may call these functions.
 */
const HISTORY_FILES = new Set([
  // Writes the dashboard path (tab and focus) and the query (filters, kiosk, edit) of this dashboard.
  'plugins/dashboards/src/DashboardPage.tsx',
  // Writes the `w.*` query parameters of one widget. The path of the current page stays.
  'plugins/dashboards/src/widgetUrlState.ts',
  // The one place that builds router links. It keeps every link inside the dashboard.
  ROUTER_LINK_FILE,
]);

/**
 * Rules that run on the whole text without comments, so a call split over lines is found too.
 * `router`: the rule also applies to the router-link file. `files`: files where the rule is off.
 */
const RULES = [
  { re: /['"`]_(blank|new|top|parent)['"`]/, msg: 'opens a new tab or window (target _blank)', router: true },
  // Any reference to `window.open`, also `window['open']` and `const o = window.open`, not only a call.
  {
    re: /\b(?:window|globalThis|self|top|parent)\s*(?:\.\s*open\b|\[\s*['"`]open['"`]\s*\])/,
    msg: 'a reference to window.open leaves the dashboard',
    router: true,
  },
  { re: /\bopen\s*\(\s*['"`]https?:/i, msg: 'open() of an address', router: true },
  {
    re: /\b(?:window|document|globalThis|self)\s*\.\s*location\s*\+?=(?!=)/,
    msg: 'assigns the location',
    router: true,
  },
  {
    re: /(?<![\w$.])(?<!\b(?:const|let|var)\s+)location\s*\+?=(?![=>])/,
    msg: 'assigns the location',
    router: true,
  },
  {
    re: /\blocation\s*(?:\.\s*href|\[\s*['"`]href['"`]\s*\])\s*\+?=(?!=)/,
    msg: 'assigns location.href',
    router: true,
  },
  {
    re: /\blocation\s*(?:\.\s*(?:assign|replace)|\[\s*['"`](?:assign|replace)['"`]\s*\])\s*\(/,
    msg: 'location.assign or location.replace leaves the dashboard',
    router: true,
  },
  { re: /\bcomponent\s*=\s*["']a["']/, msg: 'a link element (component="a")', router: true },
  {
    re: /\bcomponent\s*=\s*\{\s*(?:RouterLink|Link|NavLink)\s*\}/,
    msg: 'a router link as component (use InternalLink from links.tsx)',
    router: true,
  },
  { re: /<a[\s>]/, msg: 'an anchor element', router: true },
  {
    // A type annotation (`to: string`) and a style object (`to: { opacity: 1 }`) are not links.
    re: /(?<=(?:^|[{,(])\s*)['"]?(?:href|to)['"]?\s*:(?!\s*(?:(?:string|number|boolean|unknown|any|null|undefined|void|never)\b|\{(?!\s*(?:pathname|search|hash)\b)))/m,
    msg: 'an href or to key (an object can feed a link by prop spread)',
    router: true,
  },
  { re: /\bRouterLink\b/, msg: 'RouterLink (use InternalLink from links.tsx)' },
  { re: /\broute(Name|Params)\s*=/, msg: 'a Headlamp route link (routeName=)' },
  { re: /<(NavLink|Link)[\s>]/, msg: 'a link component (use InternalLink from links.tsx)' },
  {
    re: /\bimport\s*\{[^}]*\b(Link|NavLink)\b[^}]*\}\s*from\s*['"](react-router-dom|@kinvolk\/headlamp-plugin\/lib\/CommonComponents)['"]/,
    msg: 'imports a router or Headlamp link',
  },
  {
    re: /\bhistory\s*\.\s*(?:push|replace|go)\s*\(/,
    msg: 'history call outside the files that may write the URL (HISTORY_FILES)',
    router: true,
    files: HISTORY_FILES,
  },
  {
    re: /\b(?:pushState|replaceState|createRouteURL)\s*\(/,
    msg: 'router or history call outside the files that may write the URL (HISTORY_FILES)',
    router: true,
    files: HISTORY_FILES,
  },
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
 * The attributes of each JSX tag in the text, without the `{...}` values: [tag, attributes, offset,
 * offset of a prop spread or -1, offset of the end of the tag]. The attributes are checked here, because a tag can span lines.
 */
function jsxTags(text) {
  const tags = [];
  const open = /<([A-Za-z][\w.]*)/g;
  for (let m; (m = open.exec(text)); ) {
    let depth = 0;
    let quote = '';
    let attrs = '';
    let spread = -1;
    let i = m.index + m[0].length;
    const limit = Math.min(text.length, i + 4000);
    for (; i < limit; i++) {
      const c = text[i];
      if (quote) {
        if (c === '\\') i++;
        else if (c === quote) quote = '';
        if (depth === 0) attrs += c;
      } else if (c === '{') {
        if (depth === 0 && spread < 0 && /^\{\s*\.\.\./.test(text.slice(i, i + 24))) spread = i;
        depth++;
      } else if (c === '}') depth--;
      else if (depth === 0 && c === '>') break;
      else {
        if (depth === 0) {
          attrs += c;
          if (c === '"' || c === "'") quote = c;
        } else if (c === '"' || c === "'" || c === '`') quote = c;
      }
    }
    tags.push([m[1], attrs, m.index, spread, i]);
  }
  return tags;
}

const lineAt = (text, offset) => text.slice(0, offset).split('\n').length;

/** A spread on a component can carry href, to or target. A plain DOM tag is safe, except a and form. */
const isDomTag = tag => /^[a-z][a-z0-9]*$/.test(tag) && tag !== 'a' && tag !== 'form';

const attr = (attrs, name) => new RegExp(`(?<![\\w.-])${name}\\s*=`).test(attrs);

export function checkSource(file, text) {
  const problems = [];
  const state = { block: false };
  const isRouterFile = file === ROUTER_LINK_FILE;
  const raws = text.split('\n');
  const stripped = raws.map(raw => stripComments(raw, state)).join('\n');
  const allowed = raws.map(raw => ALLOW.test(raw));
  for (const { re, msg, router, files } of RULES) {
    if (isRouterFile && !router) continue;
    if (files?.has(file)) continue;
    for (const m of stripped.matchAll(new RegExp(re.source, re.flags.replace('g', '') + 'g'))) {
      const line = lineAt(stripped, m.index);
      if (!allowed[line - 1]) problems.push(`${file}:${line}: ${msg}`);
    }
  }
  if (!file.endsWith('.tsx')) return [...new Set(problems)];
  for (const [tag, attrs, offset, spread, end] of jsxTags(stripped)) {
    const line = lineAt(stripped, offset);
    // A marker on any line of the tag opens it, because a tag can span several lines.
    const last = lineAt(stripped, end);
    if (allowed.slice(line - 1, last).some(Boolean)) continue;
    if (attr(attrs, 'href') && !HREF_OK_TAGS.has(tag)) problems.push(`${file}:${line}: <${tag}> has href`);
    if (attr(attrs, 'target'))
      problems.push(`${file}:${line}: <${tag}> sets a link target (a link has no target)`);
    if (tag === 'form' && attr(attrs, 'action'))
      problems.push(`${file}:${line}: <form> has action (a form submit can leave the dashboard)`);
    if (isRouterFile && tag !== 'InternalLink' && attr(attrs, 'to'))
      problems.push(`${file}:${line}: <${tag}> has to (only InternalLink may take a to prop)`);
    if (spread >= 0 && !isDomTag(tag))
      problems.push(`${file}:${line}: <${tag}> has a prop spread (it can carry href, to or target)`);
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
