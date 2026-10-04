# sites

A [Headlamp](https://headlamp.dev/) plugin that lists every site served through
[Emissary-ingress](https://emissary-ingress.dev/) `Mapping` resources
(`getambassador.io/v3alpha1`), cluster-wide and live. It adds a **Sites**
sidebar entry.

## What it shows

One row per user-facing site. Mappings are folded by host: the same app served
under a tailnet name, a LAN name and a localhost name (and Mapping names ending
`-public`, `-lan`, `-localhost` or `-local`) becomes one site.

- The site name links to its primary URL, with any extra paths and alias hosts
  underneath.
- The primary URL prefers the tailnet name, then other names, then LAN, then
  localhost. Tailnet and other names use `https`; LAN and local names use `http`.
- Namespace, backing service, kind, and links to each underlying Mapping
  resource.
- Search (app, host, namespace, service, Mapping name), a kind filter (Tailnet,
  All, Local) and namespace chips. The default view shows tailnet sites only.

Hosts come from `spec.host`, falling back to `spec.hostname`. Mappings with no
host are ignored. The list is a live list/watch, so it follows Mapping changes
without a refresh. If the Emissary CRDs are absent or not readable, the page says
so instead of failing.

## Hostname suffixes

Which suffixes count as tailnet, LAN and local is configurable, because they are
deployment specific. Each takes a comma-separated list; the defaults are generic.

| Key | Default | Meaning |
| --- | --- | --- |
| `tailnetSuffixes` | `.example.com` | https names, preferred as the primary URL |
| `lanSuffixes` | `.example.net` | plain http names on the local network |
| `localSuffixes` | `.localhost` | plain http names on the machine itself |

Set them in Headlamp under Settings, Plugins, Sites. To preconfigure every
browser, ship a `defaults.json` next to `main.js` in the plugin directory (for
example written by an initContainer) using the same keys; non-empty values a user
saves in the settings override it.

## Access needed

Read (`get`, `list`, `watch`) on `mappings.getambassador.io` in all namespaces.

## Release installation

Download `sites-<version>.tar.gz` and `SHA256SUMS` from the matching GitHub
Release, verify the archive, and extract it into Headlamp's plugins directory.

```bash
sha256sum -c SHA256SUMS --ignore-missing
mkdir -p /path/to/headlamp/plugins
tar -xzf sites-0.1.0.tar.gz -C /path/to/headlamp/plugins
```

## Development

```bash
cd plugins/sites
npm ci
npm run tsc && npm run lint && npm test
npm run build       # -> dist/main.js
```
