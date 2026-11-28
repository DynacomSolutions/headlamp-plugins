// Tests of check-dashboard-links.mjs. Run: node --test scripts/check-dashboard-links.test.mjs
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkSource, defaultEntries, run, stripComments } from './check-dashboard-links.mjs';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/dashboard-links');
const fixture = name => path.join(DIR, name);
const problemsOf = name => run([fixture(name)], DIR).problems;

for (const name of [
  'pass.tsx',
  'pass-allowed.tsx',
  'pass-skips-tests.tsx',
  'pass-spread-dom.tsx',
  'pass-spread-allowed.tsx',
  'pass-types.ts',
]) {
  test(`${name} passes`, () => {
    assert.deepEqual(problemsOf(name), []);
  });
}

const FAILING = {
  'fail-blank.tsx': /fail-blank\.tsx:3: .*(new tab|link target)/,
  'fail-blank-object.ts': /fail-blank-object\.ts:1: .*new tab/,
  'fail-target.tsx': /fail-target\.tsx:4: <MuiLink> sets a link target/,
  'fail-window-open.ts': /fail-window-open.ts:1: a reference to window\.open/,
  'fail-location-href.ts': /fail-location-href\.ts:2: .*location\.href/,
  'fail-location-assign.ts': /fail-location-assign\.ts:1: location\.assign/,
  'fail-location-replace.ts': /fail-location-replace\.ts:1: location\.assign or location\.replace/,
  'fail-anchor.tsx': /fail-anchor\.tsx:3: .*(anchor|href)/,
  'fail-href-multiline.tsx': /fail-href-multiline\.tsx:4: <MuiLink> has href/,
  'fail-component-a.tsx': /fail-component-a\.tsx:3: .*component="a"/,
  'fail-router-link.tsx': /fail-router-link\.tsx:[24]: .*RouterLink/,
  'fail-route-name.tsx': /fail-route-name\.tsx:3: .*routeName/,
  'fail-transitive.tsx': /fail-transitive-child\.tsx:3: .*(anchor|href)/,
  'fail-href-key.ts': /fail-href-key\.ts:1: .*href or to key/,
  'fail-to-key.ts': /fail-to-key\.ts:1: .*href or to key/,
  'fail-spread-component.tsx': /fail-spread-component\.tsx:4: <Foo> has a prop spread/,
  'fail-spread-multiline.tsx': /fail-spread-multiline\.tsx:5: <Foo> has a prop spread/,
  'fail-spread-form.tsx': /fail-spread-form\.tsx:3: <form> has a prop spread/,
  'fail-form-action.tsx': /fail-form-action\.tsx:3: <form> has action/,
  'fail-component-link.tsx': /fail-component-link\.tsx:4: .*component/,
  'fail-target-dynamic.tsx': /fail-target-dynamic\.tsx:4: <Foo> sets a link target/,
  'fail-history-push.ts': /fail-history-push\.ts:1: history call/,
  'fail-history-replace.ts': /fail-history-replace.ts:2: history call/,
  'fail-history-go.ts': /fail-history-go\.ts:1: history call/,
  'fail-push-state.ts': /fail-push-state\.ts:1: router or history call/,
  'fail-replace-state.ts': /fail-replace-state\.ts:1: router or history call/,
  'fail-create-route-url.ts': /fail-create-route-url\.ts:1: router or history call/,
  'fail-window-open-ref.ts': /fail-window-open-ref\.ts:1: a reference to window\.open/,
  'fail-window-open-bracket.ts': /fail-window-open-bracket\.ts:1: a reference to window\.open/,
  'fail-location-bracket.ts': /fail-location-bracket\.ts:2: assigns location\.href/,
  'fail-location-assign-multiline.ts': /fail-location-assign-multiline.ts:2: location\.assign/,
  'fail-location-eq.ts': /fail-location-eq\.ts:2: assigns the location/,
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
  const src =
    "import { Link as RouterLink } from 'react-router-dom';\nconst x = <RouterLink to={t}>x</RouterLink>; // dashboard-links: allow the one router link\n";
  assert.deepEqual(checkSource('plugins/dashboards/src/links.tsx', src), []);
  // Without the marker the `to` prop of RouterLink fails, also in links.tsx.
  assert.ok(checkSource('plugins/dashboards/src/links.tsx', src.replace(/ \/\/ dashboard.*/, '')).length > 0);
  assert.ok(checkSource('plugins/dashboards/src/other.tsx', src).length > 0);
});

test('links.tsx lets only InternalLink take a to prop', () => {
  const file = 'plugins/dashboards/src/links.tsx';
  assert.deepEqual(checkSource(file, '<InternalLink to={t}>x</InternalLink>\n'), []);
  assert.ok(checkSource(file, '<Button to={t}>x</Button>\n').some(p => /has to/.test(p)));
});

test('history calls are allowed in the listed files only', () => {
  const src = 'history.push(p);\nhistory.replace(p);\n';
  assert.deepEqual(checkSource('plugins/dashboards/src/DashboardPage.tsx', src), []);
  assert.deepEqual(checkSource('plugins/dashboards/src/widgetUrlState.ts', src), []);
  assert.equal(checkSource('plugins/dashboards/src/widgets/x/View.tsx', src).length, 2);
});

test('a spread on a lowercase DOM tag passes and on a, form or a component fails', () => {
  assert.deepEqual(checkSource('x.tsx', '<div {...p}>x</div>\n'), []);
  assert.ok(checkSource('x.tsx', '<Box {...p}>x</Box>\n').length > 0);
  assert.ok(checkSource('x.tsx', '<a {...p}>x</a>\n').length > 0);
  assert.ok(checkSource('x.tsx', '<Box {...p} // dashboard-links: allow props hold no link\n>x</Box>\n').length === 0);
});

test('a non-literal or literal target fails on any tag', () => {
  assert.ok(checkSource('x.tsx', '<Box target={t}>x</Box>\n').length > 0);
  assert.ok(checkSource('x.tsx', '<Box target=\"_self\">x</Box>\n').length > 0);
});

test('a type annotation named to or href is not a link key', () => {
  assert.deepEqual(checkSource('x.ts', 'function f(from: number, to: number) {}\ntype T = { href: string };\n'), []);
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
