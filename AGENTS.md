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
| private deny-list | local only | every regex in an **untracked** deny-list |

The deny-list lives in `.identifiers-denylist` (gitignored) or at the path in
`$IDENTIFIERS_DENYLIST`. One case-insensitive regex per line. It holds the real
domains, org names, machine names, person names and emails that must never
appear. **The deny-list must never be committed or pasted into a PR, issue,
commit message or CI log**, because it would leak the identifiers it exists to
protect. CI does not have it; CI only runs the generic checks.

## Workflow

1. `make hooks` (runs `pre-commit install`; installs pre-commit and pre-push).
2. Create your own `.identifiers-denylist` (see above).
3. `make check` before pushing. Never bypass hooks with `--no-verify`.
4. Work on a task branch and open a PR; only the very first scaffold commit
   went straight to `main`.
5. Build one plugin at a time (`npm ci && npm run tsc && npm run lint && npm run build`
   inside `plugins/<name>`) to keep memory bounded.
6. PR titles, bodies and commit messages follow the same no-identifier rule.
