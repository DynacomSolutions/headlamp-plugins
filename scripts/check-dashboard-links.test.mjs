// Tests of check-dashboard-links.mjs. Run: node --test scripts/check-dashboard-links.test.mjs
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkSource, defaultEntries, run, stripComments } from './check-dashboard-links.mjs';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/dashboard-links');
const fixture = name => path.join(DIR, name);
const problemsOf = name => run([fixture(name)], DIR).problems;

for (const name of ['pass.tsx', 'pass-allowed.tsx', 'pass-skips-tests.tsx']) {
  test(`${name} passes`, () => {
    assert.deepEqual(problemsOf(name), []);
  });
}

const FAILING = {
  'fail-blank.tsx': /fail-blank\.tsx:3: .*(new tab|link target)/,
  'fail-blank-object.ts': /fail-blank-object\.ts:1: .*new tab/,
  'fail-target.tsx': /fail-target\.tsx:4: <MuiLink> sets a link target/,
  'fail-window-open.ts': /fail-window-open\.ts:1: window\.open/,
  'fail-location-href.ts': /fail-location-href\.ts:2: .*location\.href/,
  'fail-location-assign.ts': /fail-location-assign\.ts:1: location\.assign/,
  'fail-location-replace.ts': /fail-location-replace\.ts:1: location\.assign or location\.replace/,
  'fail-anchor.tsx': /fail-anchor\.tsx:3: .*(anchor|href)/,
  'fail-href-multiline.tsx': /fail-href-multiline\.tsx:4: <MuiLink> has href/,
  'fail-component-a.tsx': /fail-component-a\.tsx:3: .*component="a"/,
  'fail-router-link.tsx': /fail-router-link\.tsx:[24]: .*RouterLink/,
  'fail-route-name.tsx': /fail-route-name\.tsx:3: .*routeName/,
  'fail-transitive.tsx': /fail-transitive-child\.tsx:3: .*(anchor|href)/,
};
for (const [name, expected] of Object.entries(FAILING)) {
  test(`${name} fails with file:line`, () => {
    const problems = problemsOf(name);
    assert.ok(problems.length > 0, `${name} must fail`);
    assert.ok(
      problems.some(p => expected.test(p)),
      `${name}: ${problems.join(' | ')}`
    );
  });
}

test('the command line exits 1 on a failing entry and 0 on a passing one', async () => {
  const { spawnSync } = await import('node:child_process');
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'check-dashboard-links.mjs');
  const bad = spawnSync('node', [script, '--entry', fixture('fail-anchor.tsx')], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /fail-anchor\.tsx:3/);
  const good = spawnSync('node', [script, '--entry', fixture('pass.tsx')], { encoding: 'utf8' });
  assert.equal(good.status, 0);
});

test('the router link is allowed in links.tsx only', () => {
  const src = "import { Link as RouterLink } from 'react-router-dom';\nconst x = <RouterLink to={t}>x</RouterLink>;\n";
  assert.deepEqual(checkSource('plugins/dashboards/src/links.tsx', src), []);
  assert.ok(checkSource('plugins/dashboards/src/other.tsx', src).length > 0);
});

test('an anchor is never allowed in links.tsx', () => {
  assert.ok(checkSource('plugins/dashboards/src/links.tsx', '<a href={x}>y</a>\n').length > 0);
});

test('comments and strings are handled', () => {
  const state = { block: false };
  assert.equal(stripComments('const a = 1; // <a href="x">', state), 'const a = 1; ');
  assert.equal(stripComments("const u = 'https://example.com';", state), "const u = 'https://example.com';");
  assert.equal(stripComments('/* <a href="x"> */ ok', state), ' ok');
});

test('an allow marker needs a reason', () => {
  assert.deepEqual(checkSource('x.tsx', '<a href="u">x</a> // dashboard-links: allow a reason\n'), []);
  assert.ok(checkSource('x.tsx', '<a href="u">x</a> // dashboard-links: allow\n').length > 0);
});

test('the real entry files are found and the real tree passes', () => {
  const entries = defaultEntries().map(e => path.relative(path.join(DIR, '../../..'), e));
  assert.ok(entries.includes('plugins/dashboards/src/index.tsx'));
  assert.ok(entries.some(e => e.endsWith('plugins/incidents/src/dashboardWidgets.tsx')));
  assert.deepEqual(run(defaultEntries()).problems, []);
});
