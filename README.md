# headlamp-plugins

Plugins for [Headlamp](https://headlamp.dev/), built with
`@kinvolk/headlamp-plugin` (TypeScript + React).

| Plugin | What it does |
| --- | --- |
| [`plugins/disk-health`](plugins/disk-health) | Per-node SMART disk health and disk capacity, on the Node details page, the Nodes list, and a cluster-wide Disks page (needs a Prometheus-compatible query endpoint) |
| [`plugins/github-runners`](plugins/github-runners) | Actions Runner Controller (ARC) runner dashboard: scale sets, runners, pods, jobs, optional history |
| [`plugins/sites`](plugins/sites) | Directory of the sites served by Emissary Mappings, folded by host, live, with links to each site and its Mapping resources |

Each plugin has its own `package.json`, `Dockerfile` and README. The image is
intended to run as a Headlamp initContainer that copies `/plugin` into the
shared plugins volume.

## Public-repo rules and local checks

This repository is public. It must never contain hostnames, domains, internal
IPs, secrets, tokens, emails, usernames or organisation-internal identities;
use placeholders such as `example.com`. See [AGENTS.md](AGENTS.md).

Enforced by deterministic checks:

- **gitleaks** (pinned rev) on commit, push and in CI.
- **`scripts/check-identifiers.sh`** fails on private IPs, `*.local` /
  `*.internal` names, and emails other than `@example.com` / `noreply`.
- An optional **private deny-list** (`.identifiers-denylist`, gitignored, or
  the path in `$IDENTIFIERS_DENYLIST`) with one regex per line for your real
  domains and names. It is never committed; CI runs only the generic checks.

```bash
pipx install pre-commit     # once
make hooks                  # installs pre-commit and pre-push hooks
make check                  # identifiers + gitleaks over the tree and history
make check-plugins          # tsc, lint, build for each plugin, sequentially
```
