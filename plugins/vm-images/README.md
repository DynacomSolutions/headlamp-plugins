# vm-images

A [Headlamp](https://headlamp.dev/) plugin for virtual machine images. It adds
a **VM images** sidebar entry with one read-only page and three sections.

## What it shows

1. **KubeVirt disks** (Kubernetes API only): CDI `DataSource`s,
   `DataImportCron`s and `DataVolume`s (phase, progress, source), and for each
   `VirtualMachine` its disk volumes (PVC, DataVolume or containerDisk) with the
   PVC capacity, storage class and the VM's run state. Tables whose CRDs are not
   installed are hidden; the whole section is hidden when KubeVirt and CDI are
   absent.
2. **Registry VM images**: repositories from the catalogue backend that match
   the configured name prefixes, or whose tags have a VM artefact media type
   (`artifactType` or `configMediaType` mentioning kubevirt, containerDisk,
   qcow2, vmdk or a `vm` segment). Repositories are grouped as a tree by project, then kind (`pr`, `buildcache`, `ci`, `charts`, `mirror` become
   sub-folders; plain images sit directly under the project); a project with one
   repository is a single row, folders start collapsed and show count, size and
   latest created time, and a search opens the folders that hold a match.
   Expandable rows show tag, short digest (with a
   copy button), size, created (relative, absolute in the tooltip), platforms and
   an **In use by** count. Search by name and sort by name, size or last created.
3. **In use**: images used by pods on virtual-kubelet nodes and by KubeVirt
   containerDisks, grouped by image reference, with the pods or VMs using each
   and their node. A node is virtual-kubelet when it has the label
   `type=virtual-kubelet` or its kubelet version contains `-vk-`. The registry
   host is stripped, and the rest is matched against backend repository names,
   then by digest (from the container's `imageID`) or tag. Images not in the
   registry are listed as such. A VM's node comes from its
   `VirtualMachineInstance`.

## Backend

The registry sections read `GET /api/repositories` from a read-only catalogue
backend (not part of this repository). Each repository has `name` and `tags`
(`tag`, `digest`, `mediaType`, `artifactType`, `configMediaType`, `sizeBytes`,
`created`, `platforms`); the response also carries `generatedAt` and the last
refresh `error`. See the registry plugin README for an example payload. The
Kubernetes sections work without the backend.

## Configuration

Settings are layered: the browser's plugin settings, then an optional
`defaults.json` next to `main.js`, then the built-ins.

| Key | Default | Meaning |
| --- | --- | --- |
| `namespace` | `registry` | Namespace of the backend Service |
| `service` | `registry-catalog` | Backend Service name |
| `port` | `80` | Service port |
| `namePrefixes` | `macos-vz/,containerdisks/,vm/` | Comma-separated repository prefixes treated as VM images |
| `kindPrefixes` | `pr,buildcache,ci,charts,mirror` | First path segments that mark a repository kind in the tree |
| `refreshSeconds` | `60` | Refresh interval, 5 to 600 |

## Access (RBAC)

- `get` on `services/proxy` for the backend Service.
- `list` and `watch` on `datasources`, `dataimportcrons` and `datavolumes`
  (`cdi.kubevirt.io`), and on `virtualmachines` and `virtualmachineinstances`
  (`kubevirt.io`).
- `list` and `watch` on `persistentvolumeclaims`, `pods` and `nodes`.

A section without permission shows the error instead of its data.

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
tar -xzf vm-images-0.1.0.tar.gz -C /path/to/headlamp/plugins
```
