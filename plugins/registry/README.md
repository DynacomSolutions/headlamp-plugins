# registry

A [Headlamp](https://headlamp.dev/) plugin that lists the repositories and tags
of a container registry. It adds a **Registry** sidebar entry with one page. It
is read-only.

## What it shows

- Repositories are grouped as a tree: project, then kind, then repository. A
  project is found from the repository names (`shop-api`, `pr/12/shop-api`,
  `buildcache/my-org/shop/api` and `charts/shop` all belong to `shop`). Plain
  images sit directly under the project (`shop-api` shows as `api`); other kinds
  (`pr`, `buildcache`, `ci`, `charts`, `mirror`) become sub-folders. A project
  with one repository is a single row. Folders start collapsed and show the
  repository count, total size and latest created time; a search opens the
  folders that hold a match and hides the rest. Folder toggles are buttons with
  `aria-expanded`.
- Repositories with tag count, total size (sum of tag sizes; layers shared
  between tags are counted once per tag) and last created time.
- Expandable rows with one line per tag: tag, short digest with a **Copy**
  button for the full digest, size, created (relative, absolute in the tooltip)
  and platforms.
- A search box (repository name) and sorting by name, size or last created.
- The backend's last refresh error and its `generatedAt` time ("Updated 3
  minutes ago"), plus loading, empty and error states.

## Backend

The plugin reads `GET /api/repositories` from a small catalogue backend that
queries the registry with read-only requests and caches the result. The backend
is not part of this repository. The response looks like:

```json
{
  "generatedAt": "2026-10-15T08:00:00Z",
  "error": null,
  "repositories": [
    {
      "name": "my-org/app",
      "tags": [
        {
          "tag": "1.0.0",
          "digest": "sha256:...",
          "mediaType": "application/vnd.oci.image.manifest.v1+json",
          "artifactType": null,
          "configMediaType": "application/vnd.oci.image.config.v1+json",
          "sizeBytes": 123456789,
          "created": "2026-10-01T12:00:00Z",
          "platforms": ["linux/amd64"]
        }
      ]
    }
  ]
}
```

Tags whose fields are `null` are shown with a dash. `error` is the last refresh
error; the cached data is still shown.

## Configuration

Settings are layered: the browser's plugin settings, then an optional
`defaults.json` next to `main.js`, then the built-ins.

| Key | Default | Meaning |
| --- | --- | --- |
| `namespace` | `registry` | Namespace of the backend Service |
| `service` | `registry-catalog` | Backend Service name |
| `port` | `80` | Service port |
| `kindPrefixes` | `pr,buildcache,ci,charts,mirror` | First path segments that mark a repository kind |
| `refreshSeconds` | `60` | Refresh interval, 5 to 600 |

## Access (RBAC)

Requests go through the Kubernetes API service proxy
(`/api/v1/namespaces/<ns>/services/<name>:<port>/proxy/...`). Grant `get` on
`services/proxy` for the backend Service.

## Development

```bash
npm ci
npm run tsc
npm run lint
npm test
npm run build
```

## Installing a release

Download the versioned archive from a GitHub Release, verify it with the
matching `SHA256SUMS` file, and extract it into Headlamp's plugins directory:

```bash
sha256sum -c SHA256SUMS --ignore-missing
mkdir -p /path/to/headlamp/plugins
tar -xzf registry-0.1.0.tar.gz -C /path/to/headlamp/plugins
```
