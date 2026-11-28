# Agent and contributor rules

This repository is, or will become, **public**. Treat every byte as public.

## Never commit

- Hostnames, domains (other than `example.com`), internal or private IPs
- Secrets, tokens, keys, kubeconfigs
- Email addresses (only `@example.com` or `noreply` addresses)
- Usernames, organisation-internal names, machine or node names
- Links to private repositories or internal dashboards

Use generic placeholders: `example.com`, `my-org/my-repo`, `worker-1`,
`https://status.example.com/status.json`.

## Deterministic checks

| Check | Where it runs | What it does |
| --- | --- | --- |
| gitleaks (pinned in `.pre-commit-config.yaml`) | pre-commit, pre-push, CI | secret scan |
| `scripts/check-identifiers.sh` | pre-commit, pre-push, CI | private IPs, `*.local`/`*.internal`, non-example emails |
| private deny-list | locally if configured; always in CI | every regex in an **untracked** deny-list |
| `scripts/check-bundle.sh` | CI (after each plugin build), release | the deny-list over built bundles, defaults files and file names |

The deny-list lives in `.identifiers-denylist` (gitignored) or at the path in
`$IDENTIFIERS_DENYLIST`. One case-insensitive regex per line. It holds the real
domains, org names, machine names, person names and emails that must never
appear. **The deny-list must never be committed or pasted into a PR, issue,
commit message or CI log**, because it would leak the identifiers it exists to
protect. CI enforces the deny-list from a repository secret
(`IDENTIFIERS_DENYLIST`) and fails closed if it is unavailable; fork PRs cannot
read secrets, so a maintainer must run the check for them. Locally, point at
your copy with `IDENTIFIERS_DENYLIST=<path> scripts/check-identifiers.sh --all
--require-denylist`. Matches are reported as `file:line` only.

## Workflow

1. `make hooks` (runs `pre-commit install`; installs pre-commit and pre-push).
2. Create your own `.identifiers-denylist` (see above).
3. `make check` before pushing. Never bypass hooks with `--no-verify`.
4. Work on a task branch and open a PR; only the very first scaffold commit
   went straight to `main`.
5. Build one plugin at a time (`npm ci && npm run tsc && npm run lint && npm run build`
   inside `plugins/<name>`) to keep memory bounded.
6. PR titles, bodies and commit messages follow the same no-identifier rule.

## Dashboard and kiosk links

No link in a dashboard view (`/dashboards/<name>...`) or in a kiosk view (`?kiosk=1`) leaves the
dashboard. This covers every component that a dashboard shows, also the widgets that other plugins
add with `registerDashboardWidget`.

- A link goes to a tab of the same dashboard or to a focus path under it. Nothing else.
- No new tab or window: no `target`, no `window.open`.
- No external address as a link: no `href`, no `location.assign`, `location.replace` or `location.href =`.
  An address shows as plain text, with a copy button if the user needs it.
- No router link or Headlamp route link to another page (`RouterLink`, `routeName=`).
  `InternalLink` in `plugins/dashboards/src/links.tsx` is the one sanctioned link. It keeps the
  current query, so a click never exits kiosk or full screen mode.
- Expand in place instead of navigating: show the whole text, open a panel in the widget, or use the
  focus path (`setFocus`).

Why: the app runs as an installed web app with no browser bar, and a wall kiosk runs in full screen.
A link that leaves the dashboard traps the user on another page, or exits full screen.

`scripts/check-dashboard-links.mjs` enforces the rule. It starts at `plugins/dashboards/src/index.tsx`
and at every `plugins/*/src/dashboardWidgets.tsx`, follows relative imports, and fails with
`file:line`. It runs in `make check`, in pre-commit and in the `generic-checks` job. A shared file
that a dashboard widget imports must not contain such a link. Move the link into a file that only a
standalone page imports. A line can carry `// dashboard-links: allow <reason>` for a case that is
not a link, such as the `href` of an SVG `<image>`. Do not add a marker for an external address.

