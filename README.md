# headlamp-plugins

Plugins for [Headlamp](https://headlamp.dev/), built with
`@kinvolk/headlamp-plugin` (TypeScript + React).

| Plugin | What it does |
| --- | --- |
| [`plugins/agent-memory`](plugins/agent-memory) | Memory restrictions of an agent host (systemd slices and per-pane scopes): usage against soft and hard limits, kernel event counters, pressure, active alerts, and in-place editing of the limits through a small backend (needs the agent-memory backend) |
| [`plugins/alerting`](plugins/alerting) | Manage alerting notification channels and routes (custom resources) live from the UI, with YAML copy and download for Git; test sends; status page |
| [`plugins/disk-health`](plugins/disk-health) | Per-node SMART disk health and disk capacity, on the Node details page, the Nodes list, and a cluster-wide Disks page (needs a Prometheus-compatible query endpoint) |
| [`plugins/github-runners`](plugins/github-runners) | Actions Runner Controller (ARC) runner dashboard: scale sets, runners, pods, jobs, optional history |
| [`plugins/sites`](plugins/sites) | Directory of the sites served by Emissary Mappings, folded by host, live, with links to each site and its Mapping resources |

Each plugin is distributed as a versioned GitHub Release archive containing
the built `main.js`, its `package.json`, and any plugin assets. The alerting
archive also includes its service worker.

## Creating a release

Push a strict semantic-version tag such as `v1.2.3` or `v1.2.3-rc.1` to
create a release. The workflow stages the tag version in each plugin's
`package.json` and `package-lock.json` in its job workspace without committing
those changes, then creates and uploads four plugin archives plus
`SHA256SUMS`. Tags containing a hyphen publish as prereleases.

## Installing a release

Download the archive for the plugin and the matching `SHA256SUMS` file from a
GitHub Release, verify the checksum, and extract the archive into Headlamp's
plugins directory:

```bash
sha256sum -c SHA256SUMS --ignore-missing
mkdir -p /path/to/headlamp/plugins
tar -xzf example-plugin-0.1.0.tar.gz -C /path/to/headlamp/plugins
```

## Public-repo rules and local checks

This repository is public. It must never contain hostnames, domains, internal
IPs, secrets, tokens, emails, usernames or organisation-internal identities;
use placeholders such as `example.com`. See [AGENTS.md](AGENTS.md).

Enforced by deterministic checks:

- **gitleaks** (pinned rev) on commit, push and in CI.
- **`scripts/check-identifiers.sh`** fails on private IPs, `*.local` /
  `*.internal` names, and emails other than `@example.com` / `noreply`.
- A **private deny-list** (`.identifiers-denylist`, gitignored, or the path in
  `$IDENTIFIERS_DENYLIST`) with one regex per line for real domains and names.
  It is never committed. CI requires its repository secret and fails closed
  when it is unavailable. Fork pull requests cannot read repository secrets,
  so a maintainer must run the private check locally for them; generic checks
  still run in CI.

```bash
pipx install pre-commit     # once
make hooks                  # installs pre-commit and pre-push hooks
make check                  # identifiers + gitleaks over the tree and history
make check-plugins          # tsc, lint, build for each plugin, sequentially
```
